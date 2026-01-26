import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show kDebugMode;

import 'translation_batch_result.dart';
import 'translation_client.dart';

/// Minimal proxy client: always calls a fixed Worker base URL.
///
/// - No SharedPreferences
/// - No flags/settings
/// - No caching/retries
/// - Errors throw (callsite already catches)
class ProxyTranslationClient implements TranslationClient {
  ProxyTranslationClient({required Uri baseUrl}) : _baseUrl = baseUrl;

  final Uri _baseUrl;

  Uri _translateBatchUri() => _baseUrl.resolve('/translateBatch');

  static String _normalizeSourceLang(String sourceLang) {
    final raw = sourceLang.toLowerCase().trim().replaceAll('_', '-');
    if (raw.isEmpty) return 'auto';
    if (raw == 'auto') return 'auto';
    final ok = RegExp(r'^[a-z]{2,5}(-[a-z]{2,5})?$').hasMatch(raw);
    return ok ? raw : 'auto';
  }

  @override
  Future<String> translate({
    required String text,
    required String targetLang,
    String sourceLang = 'auto',
  }) async {
    final out = await translateBatch(
      texts: <String>[text],
      targetLang: targetLang,
      sourceLang: sourceLang,
    );
    return out.translated.isNotEmpty ? out.translated.first : '';
  }

  @override
  Future<TranslationBatchResult> translateBatch({
    required List<String> texts,
    required String targetLang,
    String sourceLang = 'auto',
  }) async {
    final uri = _translateBatchUri();
    final normalizedSourceLang = _normalizeSourceLang(sourceLang);
    final client = HttpClient();
    client.connectionTimeout = const Duration(seconds: 10);

    try {
      final req = await client.postUrl(uri);
      req.headers.contentType = ContentType.json;
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (kDebugMode) {
        req.headers.set('x-debug', '1');
      }

      // Payload includes at minimum { target, texts }.
      // We also pass `source` to avoid unnecessary auto-detection where possible.
      req.write(
        jsonEncode(<String, Object?>{
          'target': targetLang,
          'texts': texts,
          'source': normalizedSourceLang,
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
          if (out.length == texts.length) {
            return TranslationBatchResult(
              translated: out,
              mode: decoded['mode']?.toString(),
              rule: decoded['rule']?.toString(),
              build: decoded['build']?.toString(),
            );
          }
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

