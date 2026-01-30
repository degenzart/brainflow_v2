import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;

import 'translation_client.dart';

/// Minimal proxy client: always calls a fixed Worker base URL.
/// Uses HttpClient with findProxy = DIRECT so translation requests never use a system proxy (avoids localhost:55xxx).
class ProxyTranslationClient implements TranslationClient {
  ProxyTranslationClient({required Uri baseUrl}) : _baseUrl = baseUrl;

  final Uri _baseUrl;

  Uri _translateBatchUri() => _baseUrl.resolve('/translateBatch');

  @override
  Future<String> translate({
    required String text,
    required String targetLang,
    String sourceLang = 'auto',
  }) async {
    final out = await translateBatch(texts: <String>[text], targetLang: targetLang);
    return out.isNotEmpty ? out.first : '';
  }

  @override
  Future<List<String>> translateBatch({
    required List<String> texts,
    required String targetLang,
    String sourceLang = 'auto',
  }) async {
    final uri = _translateBatchUri();
    final client = HttpClient();
    client.findProxy = (_) => 'DIRECT';
    client.connectionTimeout = const Duration(seconds: 15);
    if (kDebugMode) {
      debugPrint('TRANSLATION_HTTP uri=${uri.host} proxy=DIRECT');
    }

    try {
      final req = await client.postUrl(uri);
      req.headers.contentType = ContentType.json;
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');

      // EXACT payload as requested: { target, texts }
      req.write(
        jsonEncode(<String, Object?>{
          'target': targetLang,
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

