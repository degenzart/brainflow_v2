import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;

import '../cards/card_model.dart';
import '../utils/html_entities.dart';

/// Caps per source (fixed).
const int kEnCap = 1000;
const int kDeCap = 900;

/// Per auto-import run: fetch at most this many EN cards (avoids hammering API).
const int kEnChunkPerRun = 200;

/// OpenTDB returns max 50 per request.
const int _requestBatchSize = 50;

/// Backoff delays for 429 retries (seconds).
const List<int> _retryDelaysSec = [2, 4, 8];
const int _maxRetries = 3;
const int _jitterMsMax = 300;

class TriviaImporter {
  const TriviaImporter();

  /// Fetch EN cards from OpenTDB-compatible API (opentdb.com). Cap = max for this run (use kEnChunkPerRun for auto-import).
  /// On 429: Retry-After header if present, else backoff + jitter; max retries then giveup with url.
  Future<List<CardModel>> fetchEN({int cap = kEnCap}) async {
    const source = 'opentdb.com';
    const sourceLanguage = 'en';
    final chunk = cap.clamp(1, kEnCap);
    debugPrint('IMPORT_START source=$source language=$sourceLanguage chunk=$chunk cap=$kEnCap');

    final client = HttpClient();
    final allRaw = <Map<String, dynamic>>[];
    var totalRetries = 0;
    var lastHttpStatus = 0;
    Uri? lastUri;
    try {
      int requested = 0;
      while (requested < cap) {
        final amount = (cap - requested).clamp(1, _requestBatchSize);
        final uri = Uri.https('opentdb.com', '/api.php', <String, String>{
          'amount': '$amount',
          'type': 'multiple',
        });
        lastUri = uri;
        var attempt = 0;
        HttpClientResponse? res;
        while (true) {
          final req = await client.getUrl(uri);
          req.headers.set(HttpHeaders.acceptHeader, 'application/json');
          res = await req.close();
          lastHttpStatus = res.statusCode;
          if (res.statusCode == 429 && attempt < _maxRetries) {
            await res.drain();
            totalRetries++;
            attempt++;
            var delaySec = _retryDelaysSec[attempt - 1];
            final retryAfter = res.headers.value('retry-after');
            if (retryAfter != null) {
              final sec = int.tryParse(retryAfter);
              if (sec != null && sec > 0) delaySec = sec;
            }
            final jitterMs = math.Random().nextInt(_jitterMsMax + 1);
            debugPrint('IMPORT_FETCH_RETRY source=$source status=429 attempt=$attempt delay=${delaySec}s url=$uri');
            await Future<void>.delayed(Duration(seconds: delaySec, milliseconds: jitterMs));
            continue;
          }
          break;
        }
        if (res.statusCode == 429) {
          debugPrint('IMPORT_FETCH_GIVEUP status=429 retries=$totalRetries url=$lastUri');
          break;
        }
        if (res.statusCode != 200) {
          debugPrint('IMPORT_FETCH_FAIL source=$source status=${res.statusCode} url=$uri');
          break;
        }
        final body = await res.transform(utf8.decoder).join();
        final decoded = jsonDecode(body) as Map<String, dynamic>;
        final responseCode = decoded['response_code'] as int?;
        if (responseCode != 0) {
          debugPrint('IMPORT_FETCH_FAIL source=$source response_code=$responseCode url=$uri');
          break;
        }
        final results = decoded['results'] as List<dynamic>?;
        if (results == null || results.isEmpty) break;
        for (final r in results) {
          if (r is Map<String, dynamic>) allRaw.add(r);
        }
        requested += results.length;
        if (results.length < amount) break;
      }
      if (allRaw.isNotEmpty) {
        debugPrint('IMPORT_FETCH_OK source=$source received=${allRaw.length}');
      }
    } catch (e, st) {
      debugPrint('IMPORT_FETCH_EXCEPTION source=$source error=$e url=$lastUri');
      if (kDebugMode) debugPrint('$st');
    } finally {
      client.close(force: true);
    }

    final normalized = normalize(allRaw, sourceLanguage, source);
    debugPrint(
      'IMPORT_NORMALIZED_OK source=$source kept=${normalized.kept.length} dropped=${normalized.dropped}'
      '${normalized.droppedReasons.isNotEmpty ? " reasons=${normalized.droppedReasons}" : ""}',
    );
    final status = lastHttpStatus == 429 && totalRetries >= _maxRetries ? 'fail' : (allRaw.isEmpty ? 'fail' : 'ok');
    final urlLog = lastUri?.toString() ?? '';
    debugPrint(
      'IMPORT_SOURCE_RESULT source=$source status=$status http=$lastHttpStatus received=${allRaw.length} kept=${normalized.kept.length} dropped=${normalized.dropped} retries=$totalRetries url=$urlLog',
    );
    return normalized.kept;
  }

  /// DE source (opentrivia.de) disabled; use EN + translate for DE.
  Future<List<CardModel>> fetchDE({int cap = kDeCap}) async {
    return [];
  }

  /// Normalize raw API items into CardModels. Decode HTML, filter bad data, stable IDs.
  NormalizeResult normalize(
    List<Map<String, dynamic>> rawList,
    String sourceLanguage,
    String sourceLabel,
  ) {
    final kept = <CardModel>[];
    final droppedReasons = <String>[];
    final now = DateTime.now();
    final lang = sourceLanguage.trim().toLowerCase();
    if (lang.isEmpty) return NormalizeResult(kept: kept, dropped: rawList.length, droppedReasons: droppedReasons);

    for (final map in rawList) {
      try {
        final question = _decode(map['question']).trim();
        final correct = _decode(map['correct_answer']).trim();
        final incorrectRaw = map['incorrect_answers'];
        final incorrect = incorrectRaw is List<dynamic>
            ? (incorrectRaw.map((e) => _decode(e?.toString() ?? '').trim()).toList())
            : <String>[];

        if (question.isEmpty) {
          droppedReasons.add('empty_question');
          continue;
        }
        if (correct.isEmpty) {
          droppedReasons.add('empty_correct');
          continue;
        }
        final allAnswers = <String>[...incorrect, correct]..sort();
        if (allAnswers.length < 2) {
          droppedReasons.add('too_few_answers');
          continue;
        }
        if (Set<String>.from(allAnswers).length != allAnswers.length) {
          droppedReasons.add('duplicate_answers');
          continue;
        }
        final correctIndex = allAnswers.indexOf(correct);
        if (correctIndex < 0 || correctIndex >= allAnswers.length) {
          droppedReasons.add('correct_index_out_of_range');
          continue;
        }

        final id = TriviaImporter.stableId(
          source: sourceLabel,
          sourceLanguage: lang,
          question: question,
          correctAnswer: correct,
          incorrectAnswers: incorrect,
        );
        final card = CardModel(
          id: id,
          question: question,
          answers: allAnswers,
          correctAnswer: correct,
          sourceLanguage: lang,
          category: _decode(map['category']?.toString()),
          difficulty: (map['difficulty']?.toString() ?? '').toLowerCase().trim().isNotEmpty
              ? (map['difficulty'] as String?)?.toLowerCase()
              : null,
          createdAt: now,
          source: sourceLabel,
        );
        kept.add(card);
      } catch (e) {
        droppedReasons.add('parse:$e');
      }
    }
    // Deduplicate by ID (first occurrence wins)
    final byId = <String, CardModel>{};
    for (final c in kept) {
      byId.putIfAbsent(c.id, () => c);
    }
    final keptUnique = byId.values.toList(growable: false);
    return NormalizeResult(
      kept: keptUnique,
      dropped: rawList.length - keptUnique.length,
      droppedReasons: droppedReasons,
    );
  }

  /// Stable ID: hash of source + sourceLanguage + question + answers + correctAnswer (idempotent).
  static String stableId({
    required String source,
    required String sourceLanguage,
    required String question,
    required String correctAnswer,
    required List<String> incorrectAnswers,
  }) {
    const int fnvOffsetBasis = 0xcbf29ce484222325;
    const int fnvPrime = 0x100000001b3;
    int hash = fnvOffsetBasis;
    void add(String s) {
      final bytes = utf8.encode(s);
      for (final b in bytes) {
        hash ^= b;
        hash = (hash * fnvPrime) & 0xFFFFFFFFFFFFFFFF;
      }
      hash ^= 0xFF;
      hash = (hash * fnvPrime) & 0xFFFFFFFFFFFFFFFF;
    }
    add(source);
    add(sourceLanguage);
    add(question);
    add(correctAnswer);
    for (final a in incorrectAnswers) {
      add(a);
    }
    final hex = hash.toRadixString(16).padLeft(16, '0');
    return 'trivia_${sourceLanguage}_$hex';
  }

  String _decode(String? input) {
    if (input == null || input.isEmpty) return '';
    return decodeHtmlEntities(input);
  }

  /// Legacy: single fetch for UI "Import 25" (EN only). Kept for compatibility.
  Future<List<CardModel>> fetch({int amount = 25}) async {
    final list = await fetchEN(cap: amount.clamp(1, _requestBatchSize));
    return list;
  }
}

class NormalizeResult {
  const NormalizeResult({
    required this.kept,
    required this.dropped,
    this.droppedReasons = const [],
  });
  final List<CardModel> kept;
  final int dropped;
  final List<String> droppedReasons;
}
