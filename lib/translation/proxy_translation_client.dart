import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import 'translation_client.dart';

class ProxyTranslationClient implements TranslationClient {
  ProxyTranslationClient(this._prefs);

  static const String proxyBaseUrlKey = 'translation_proxy_base_url';
  static const String proxyClientKeyKey = 'translation_proxy_client_key';
  static const String defaultBaseUrl = 'http://localhost:8787';

  final SharedPreferences _prefs;

  Uri _translateUri() {
    final raw = (_prefs.getString(proxyBaseUrlKey) ?? defaultBaseUrl).trim();
    final base = Uri.parse(raw);
    // Handles both http://host:port and http://host:port/some/base/path/
    return base.resolve('translate');
  }

  Uri _translateBatchUri() {
    final raw = (_prefs.getString(proxyBaseUrlKey) ?? defaultBaseUrl).trim();
    final base = Uri.parse(raw);
    return base.resolve('translateBatch');
  }

  void _applyOptionalClientKey(HttpClientRequest req) {
    final clientKey = (_prefs.getString(proxyClientKeyKey) ?? '').trim();
    if (clientKey.isEmpty) return;
    req.headers.set('X-Client-Key', clientKey);
  }

  @override
  Future<String> translate({
    required String text,
    required String targetLang,
    String sourceLang = 'auto',
  }) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return text;

    // Keep single-translate available, but implement it via batch to ensure
    // consistent behavior with the Worker.
    final out = await translateBatch(
      texts: <String>[text],
      targetLang: targetLang,
      sourceLang: sourceLang,
    );
    return out.isNotEmpty ? out.first : text;
  }

  @override
  Future<List<String>> translateBatch({
    required List<String> texts,
    required String targetLang,
    String sourceLang = 'auto',
  }) async {
    if (texts.isEmpty) return const <String>[];
    if (texts.length > 20) {
      throw ArgumentError('texts must have <= 20 items');
    }

    final uri = _translateBatchUri();
    final client = HttpClient();
    client.connectionTimeout = const Duration(seconds: 10);

    try {
      final req = await client.postUrl(uri);
      req.headers.contentType = ContentType.json;
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      _applyOptionalClientKey(req);
      req.write(
        jsonEncode(<String, Object?>{
          'target': targetLang,
          'source': sourceLang,
          'texts': texts,
        }),
      );

      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();

      if (res.statusCode != 200) {
        throw HttpException(
          'Unexpected status ${res.statusCode}: $body',
          uri: uri,
        );
      }

      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic>) {
        final arr = decoded['translated'];
        if (arr is List) {
          final out = arr.map((e) => e?.toString() ?? '').toList(growable: false);
          if (out.length == texts.length) return out;
          throw FormatException(
            'Unexpected translated length ${out.length} (expected ${texts.length})',
          );
        }
      }

      throw const FormatException('Missing translated array in response.');
    } finally {
      client.close(force: true);
    }
  }
}

