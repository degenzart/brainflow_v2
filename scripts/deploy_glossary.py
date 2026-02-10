#!/usr/bin/env python3
"""
Deploy glossary CSV to Google Cloud Translation v3.
Uses env: GCP_PROJECT_ID, GLOSSARY_LOCATION, GLOSSARY_ID, GLOSSARY_BUCKET, GLOSSARY_CSV, GCP_SA_JSON_FILE.
Requires: python3, openssl, service account JSON at .secrets/gcp_sa.json (or GCP_SA_JSON_FILE).
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Optional, Union

# -----------------------------------------------------------------------------
# Env
# -----------------------------------------------------------------------------
GCP_PROJECT_ID = os.environ.get("GCP_PROJECT_ID")
GLOSSARY_LOCATION = os.environ.get("GLOSSARY_LOCATION", "us-central1")
GLOSSARY_ID = os.environ.get("GLOSSARY_ID", "brainflow_en_de_main")
GLOSSARY_BUCKET = os.environ.get("GLOSSARY_BUCKET", "brainflow-translate-glossary")
GLOSSARY_CSV = os.environ.get("GLOSSARY_CSV")
GCP_SA_JSON_FILE = os.environ.get("GCP_SA_JSON_FILE")

for var, name in [
    (GCP_PROJECT_ID, "GCP_PROJECT_ID"),
    (GLOSSARY_CSV, "GLOSSARY_CSV"),
    (GCP_SA_JSON_FILE, "GCP_SA_JSON_FILE"),
]:
    if not var:
        raise SystemExit(f"ERROR: {name} is not set")

# -----------------------------------------------------------------------------
# JWT / Token (stdlib + openssl)
# -----------------------------------------------------------------------------


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(client_email: str, private_key: str) -> str:
    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    payload = {
        "iss": client_email,
        "scope": "https://www.googleapis.com/auth/cloud-platform",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }
    header_b64 = b64url(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = b64url(json.dumps(payload, separators=(",", ":")).encode())
    message = f"{header_b64}.{payload_b64}".encode()

    with tempfile.NamedTemporaryFile(mode="w", suffix=".pem", delete=False) as f:
        f.write(private_key)
        key_path = f.name
    try:
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", key_path],
            input=message,
            capture_output=True,
            check=True,
        )
        sig_b64 = b64url(result.stdout)
        return f"{header_b64}.{payload_b64}.{sig_b64}"
    finally:
        os.unlink(key_path)


def get_access_token(sa: dict) -> str:
    jwt = make_jwt(sa["client_email"], sa["private_key"])
    body = urllib.parse.urlencode(
        {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": jwt}
    ).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
    return data["access_token"]


# -----------------------------------------------------------------------------
# GCS upload
# -----------------------------------------------------------------------------


def upload_csv_to_gcs(token: str, bucket: str, object_name: str, csv_path: str) -> str:
    with open(csv_path, "rb") as f:
        body = f.read()
    url = (
        "https://storage.googleapis.com/upload/storage/v1/b/"
        f"{bucket}/o?uploadType=media&name={urllib.parse.quote(object_name, safe='')}"
    )
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "text/csv; charset=utf-8",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        out = json.loads(resp.read().decode())
    return f"gs://{bucket}/{object_name}"


# -----------------------------------------------------------------------------
# Translation API: delete / create / poll
# -----------------------------------------------------------------------------


def api_request(
    token: str,
    method: str,
    url: str,
    data: Optional[dict] = None,
) -> tuple[int, Optional[dict]]:
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode() if data else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode()
            return resp.status, json.loads(body) if body.strip() else None
    except urllib.error.HTTPError as e:
        return e.code, None


def main() -> None:
    print("Loading service account...")
    with open(GCP_SA_JSON_FILE) as f:
        sa = json.load(f)

    print("Getting access token...")
    token = get_access_token(sa)

    # Object name with timestamp
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    object_name = f"glossaries/{GLOSSARY_ID}-{ts}.csv"

    print(f"Uploading CSV to gs://{GLOSSARY_BUCKET}/{object_name} ...")
    gs_uri = upload_csv_to_gcs(token, GLOSSARY_BUCKET, object_name, GLOSSARY_CSV)
    print(f"Uploaded: {gs_uri}")

    base_url = (
        f"https://translation.googleapis.com/v3/projects/{GCP_PROJECT_ID}"
        f"/locations/{GLOSSARY_LOCATION}"
    )
    glossary_url = f"{base_url}/glossaries/{GLOSSARY_ID}"

    print("Deleting existing glossary (if any)...")
    status, _ = api_request(token, "DELETE", glossary_url)
    if status == 404:
        print("  (no existing glossary)")
    elif status in (200, 204):
        print("  deleted.")
    else:
        raise SystemExit(f"Delete failed: HTTP {status}")

    print("Creating new glossary...")
    create_url = f"{base_url}/glossaries"
    body = {
        "name": f"projects/{GCP_PROJECT_ID}/locations/{GLOSSARY_LOCATION}/glossaries/{GLOSSARY_ID}",
        "languagePair": {"sourceLanguageCode": "en", "targetLanguageCode": "de"},
        "inputConfig": {"gcsSource": {"inputUri": gs_uri}},
    }
    status, create_resp = api_request(token, "POST", create_url, body)
    if status not in (200, 201):
        raise SystemExit(f"Create failed: HTTP {status}")
    if not create_resp or "name" not in create_resp:
        raise SystemExit("Create response missing operation name")
    operation_name = create_resp["name"]
    operation_url = f"https://translation.googleapis.com/v3/{operation_name.lstrip('/')}"
    print("  create request accepted, polling operation...")

    print("Waiting for operation to complete (max 300s)...")
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        time.sleep(3)
        status, op_data = api_request(token, "GET", operation_url)
        if status != 200:
            raise SystemExit(f"Get operation failed: HTTP {status}")
        if not op_data:
            continue
        if op_data.get("done"):
            err = op_data.get("error")
            if err:
                code = err.get("code", "")
                msg = err.get("message", str(err))
                details = err.get("details")
                print(f"Operation error: code={code} message={msg}", file=sys.stderr)
                if details:
                    print(f"Details: {json.dumps(details, indent=2)}", file=sys.stderr)
                raise SystemExit(1)
            print("  Operation done.")
            break
        print("  ... still running")
    else:
        raise SystemExit("Timeout waiting for operation.")

    # Confirm glossary is READY (poll glossary if still CREATING, max 180s)
    deadline_glossary = time.monotonic() + 180
    while time.monotonic() < deadline_glossary:
        status, data = api_request(token, "GET", glossary_url)
        if status != 200:
            raise SystemExit(f"Get glossary failed: HTTP {status}")
        if data and data.get("endTime") and data.get("name", "").endswith(f"/glossaries/{GLOSSARY_ID}"):
            pass  # ok
        if data and data.get("state") == "READY":
            print("  READY.")
            break
        if data and data.get("state") == "CREATING":
            print("  ... glossary still CREATING, waiting")
            time.sleep(3)
            continue
        time.sleep(3)
    else:
        raise SystemExit("Timeout waiting for glossary READY.")

    print("Done. Glossary deployed successfully.")


if __name__ == "__main__":
    main()
