import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/foundation.dart' show debugPrint;

import 'card_model.dart';
import '../import/trivia_importer.dart';
import '../translation/proxy_translation_client.dart';

class CardRepository {
  CardRepository(this._prefs);

  static bool _workerBaseLogged = false;

  static const String _cardsKey = 'cards_v1';
  static const String _importDoneKey = 'auto_import_done_v1';
  static const String _autoImportLastAtKey = 'auto_import_last_at_v1';
  static const String _autoImportLastReasonKey = 'auto_import_last_reason_v1';
  static const String _autoImportConsumedKey = 'auto_import_consumed_v1';
  static const List<String> _contentLanguages = <String>['en', 'de', 'es'];

  /// Auto-import triggers when remainingRatio <= this (or total < kMinPool).
  static const double kAutoImportThreshold = 0.6;
  static const int kMinPool = 200;
  static const int kCooldownMinutes = 10;

  /// Bootstrap (empty DB): fetch EN cap, translate to DE+ES, persist. No demo cards.
  static const int kBootstrapEnCount = 50;
  static const List<String> kBootstrapTargetLangs = <String>['de', 'es'];
  static const double kBootstrapMaxFailuresRatio = 0.5;

  final SharedPreferences _prefs;
  bool _importRunning = false;

  /// Whether the auto-import pipeline has completed at least once.
  bool get isImportDone => _prefs.getBool(_importDoneKey) ?? false;

  /// Last auto-import timestamp (milliseconds since epoch), or null.
  int? get lastImportAt => _prefs.getInt(_autoImportLastAtKey);

  /// Last auto-import reason (startup, low_stock, consumed, language_change).
  String? get lastImportReason => _prefs.getString(_autoImportLastReasonKey);

  /// Cards consumed (swipe/next) since last successful import.
  int get cardsConsumedSinceImport => _prefs.getInt(_autoImportConsumedKey) ?? 0;

  void incrementCardsConsumedSinceImport() {
    _prefs.setInt(_autoImportConsumedKey, cardsConsumedSinceImport + 1);
  }

  void _resetCardsConsumedAfterImport() {
    _prefs.setInt(_autoImportConsumedKey, 0);
  }

  /// Always use production Cloudflare worker. Local wrangler dev is for curl only.
  ProxyTranslationClient createTranslationClient() {
    const baseUrl = 'http://127.0.0.1:8788';
    if (!_workerBaseLogged) {
      debugPrint('TRANSLATION_WORKER_BASE=$baseUrl');
      _workerBaseLogged = true;
    }
    return ProxyTranslationClient(baseUrl: Uri.parse(baseUrl));
  }

  Future<List<CardModel>> load() async {
    final raw = _prefs.getString(_cardsKey);
    if (raw == null || raw.trim().isEmpty) return const <CardModel>[];

    try {
      return CardModel.decodeList(raw);
    } catch (_) {
      // If storage got corrupted, don't crash the app.
      return const <CardModel>[];
    }
  }

  /// No-op: seed/demo cards disabled; only importer fills DB.
  Future<void> ensureSeed() async {}

  /// Resolves a card for a specific locale.
  /// Translations are applied atomically: only if question AND all answers are present and complete.
  /// Otherwise the original card is returned unchanged to avoid mixed-language UI.
  CardModel resolveForLocale(CardModel raw, String localeCode) {
    // Normalize locale code (e.g., 'en_US' -> 'en')
    final targetLang = localeCode.split('_').first.toLowerCase().trim();

    final baseEntry = raw.languageMap[raw.sourceLanguage];
    final targetEntry = (targetLang.isNotEmpty) ? raw.languageMap[targetLang] : null;
    // No translation or no base entry – fall back to original card.
    if (baseEntry == null || targetEntry == null || targetLang == raw.sourceLanguage) {
      final resolved = baseEntry ?? targetEntry;
      if (resolved == null) return raw;
      final idx = resolved.correctIndex;
      final correctAnswer =
          (idx >= 0 && idx < resolved.answers.length) ? resolved.answers[idx] : raw.correctAnswer;
      return CardModel(
        id: raw.id,
        question: resolved.question,
        answers: resolved.answers,
        correctAnswer: correctAnswer,
        sourceLanguage: raw.sourceLanguage,
        languageMap: raw.languageMap,
        category: raw.category,
        difficulty: raw.difficulty,
        createdAt: raw.createdAt,
        source: raw.source,
      );
    }

    // Atomic translation check: require complete question + answers before using targetEntry.
    final translatedQuestion = targetEntry.question;
    final translatedAnswers = targetEntry.answers;
    final baseAnswers = baseEntry.answers;
    final hasQuestion = translatedQuestion.trim().isNotEmpty;
    final hasAnswers = translatedAnswers.isNotEmpty &&
        translatedAnswers.length == baseAnswers.length &&
        translatedAnswers.every((a) => a.trim().isNotEmpty);

    if (!hasQuestion || !hasAnswers) {
      debugPrint(
        'RESOLVE_LOCALE_INCOMPLETE id=${raw.id} lang=$targetLang q=$hasQuestion a=$hasAnswers',
      );
      return raw;
    }

    final idx = targetEntry.correctIndex;
    final correctAnswer =
        (idx >= 0 && idx < translatedAnswers.length) ? translatedAnswers[idx] : raw.correctAnswer;

    return CardModel(
      id: raw.id,
      question: translatedQuestion,
      answers: translatedAnswers,
      correctAnswer: correctAnswer,
      sourceLanguage: raw.sourceLanguage,
      languageMap: raw.languageMap,
      category: raw.category,
      difficulty: raw.difficulty,
      createdAt: raw.createdAt,
      source: raw.source,
    );
  }

  /// Runs auto-import if low stock and not in cooldown. Returns true if import was started.
  /// Call from HomeScreen (startup, language_change, consumed). Logs AUTO_IMPORT_TRIGGERED or AUTO_IMPORT_SKIPPED.
  Future<bool> runAutoImportIfNeeded(
    String reason,
    int total,
    double remainingRatio,
    String effectiveLang,
    TriviaImporter importer,
  ) async {
    final cooldownOk = _checkCooldownOk();
    final lowStock = total < kMinPool || remainingRatio <= kAutoImportThreshold;
    final lastImport = lastImportAt;

    if (_importRunning) {
      debugPrint(
        'AUTO_IMPORT_SKIPPED reason=already_running total=$total remainingRatio=$remainingRatio lastImport=$lastImport',
      );
      return false;
    }
    if (!lowStock) {
      debugPrint(
        'AUTO_IMPORT_SKIPPED reason=not_low_stock total=$total remainingRatio=$remainingRatio threshold=$kAutoImportThreshold',
      );
      return false;
    }
    if (!cooldownOk) {
      debugPrint(
        'AUTO_IMPORT_SKIPPED reason=cooldown remainingRatio=$remainingRatio total=$total lastImport=$lastImport cooldownOk=false',
      );
      return false;
    }

    _importRunning = true;
    debugPrint(
      'AUTO_IMPORT_TRIGGERED reason=$reason total=$total remainingRatio=$remainingRatio cooldownOk=true threshold=$kAutoImportThreshold',
    );
    try {
      final result = await runImportPipeline(
        importer,
        effectiveLang,
        total: total,
        reason: reason,
      );
      if (result != null) {
        final now = DateTime.now().millisecondsSinceEpoch;
        _prefs.setInt(_autoImportLastAtKey, now);
        _prefs.setString(_autoImportLastReasonKey, reason);
        _resetCardsConsumedAfterImport();
        debugPrint(
          'AUTO_IMPORT_DONE new=${result.newCount} total=${result.total} durationMs=${result.durationMs}',
        );
        return true;
      }
      debugPrint('AUTO_IMPORT_FAILED reason=pipeline_returned_null');
      return false;
    } catch (e, st) {
      debugPrint('AUTO_IMPORT_FAILED reason=$e');
      assert(() {
        debugPrint('$st');
        return true;
      }());
      return false;
    } finally {
      _importRunning = false;
    }
  }

  bool _checkCooldownOk() {
    final last = lastImportAt;
    if (last == null) return true;
    final elapsed = DateTime.now().millisecondsSinceEpoch - last;
    return elapsed >= kCooldownMinutes * 60 * 1000;
  }

  Future<void> save(List<CardModel> cards) async {
    await _prefs.setString(_cardsKey, CardModel.encodeList(cards));
  }

  /// Merges [incoming] into existing storage without running translation.
  /// Use for auto-import pipeline (raw EN/DE only). Returns inserted + skipped counts.
  Future<MergeResult> mergeAndPersistRaw(List<CardModel> incoming) async {
    final existing = await load();
    final byId = <String, CardModel>{
      for (final c in existing) c.id: c,
    };

    var inserted = 0;
    for (final incomingCard in incoming) {
      final current = byId[incomingCard.id];
      if (current == null) {
        inserted++;
        byId[incomingCard.id] = incomingCard;
        continue;
      }
      final mergedLanguageMap = <String, CardText>{
        ...current.languageMap,
        ...incomingCard.languageMap.map((k, v) => MapEntry(k, current.languageMap[k] ?? v)),
      };
      byId[incomingCard.id] = CardModel(
        id: current.id,
        question: current.question,
        answers: current.answers,
        correctAnswer: current.correctAnswer,
        sourceLanguage: current.sourceLanguage,
        languageMap: mergedLanguageMap,
        category: current.category,
        difficulty: current.difficulty,
        createdAt: current.createdAt,
        source: current.source,
      );
    }

    final merged = byId.values.toList(growable: false)
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    await save(merged);
    final skipped = incoming.length - inserted;
    return MergeResult(cards: merged, newCount: inserted, skippedCount: skipped);
  }

  /// Runs the auto-import pipeline: EN (cap 1000) + DE (cap 900). Best effort per source.
  /// Does not run translation. Sets [isImportDone] when finished. Logs IMPORT_*.
  Future<void> runAutoImport(TriviaImporter importer) async {
    try {
      final enCards = await importer.fetchEN(cap: kEnCap);
      final resultEn = await mergeAndPersistRaw(enCards);
      debugPrint(
        'IMPORT_SAVED_OK source=opentdb.com inserted=${resultEn.newCount} skipped=${resultEn.skippedCount}',
      );

      final deCards = await importer.fetchDE(cap: kDeCap);
      final resultDe = await mergeAndPersistRaw(deCards);
      debugPrint(
        'IMPORT_SAVED_OK source=opentrivia.de inserted=${resultDe.newCount} skipped=${resultDe.skippedCount}',
      );

      await _prefs.setBool(_importDoneKey, true);
      final all = await load();
      final enCount = all.where((c) => c.sourceLanguage == 'en').length;
      final deCount = all.where((c) => c.sourceLanguage == 'de').length;
      debugPrint('IMPORT_DONE Totals: en=$enCount de=$deCount total=${all.length}');
    } catch (e, st) {
      debugPrint('IMPORT_DONE_FAIL error=$e');
      assert(() {
        debugPrint('$st');
        return true;
      }());
    }
  }

  /// Minimum DE native cards when effective language is DE.
  static const int kMinDeNative = 700;
  /// Target total cards after pipeline (when adding EN supplement).
  static const int kTargetTotal = 1000;

  /// Translates EN cards to de + es via worker. Never drops cards: keeps card (at least EN),
  /// only skips writing target lang into languageMap when translation is "bad".
  /// Return always has same number of cards as input (enCards with sourceLanguage==en).
  Future<TranslateEnCardsResult> translateEnCardsStrict(List<CardModel> enCards) async {
    final enOnly = enCards.where((c) => c.sourceLanguage == 'en').toList();
    if (enOnly.isEmpty) {
      return TranslateEnCardsResult(cards: <CardModel>[], failedCount: 0, attemptedCount: 0);
    }
    final client = createTranslationClient();
    final result = <CardModel>[];
    var translatedDe = 0;
    var translatedEs = 0;
    var fallbackDe = 0;
    var fallbackEs = 0;
    var failCount = 0;

    for (final card in enOnly) {
      final sourceEntry = card.languageMap['en'];
      if (sourceEntry == null) {
        result.add(card);
        continue;
      }
      final hasDe = card.languageMap.containsKey('de');
      final hasEs = card.languageMap.containsKey('es');
      var updated = card;

      if (!hasDe) {
        try {
          final texts = <String>[sourceEntry.question, ...sourceEntry.answers];
          final translated = await client.translateBatch(
            texts: texts,
            targetLang: 'de',
            sourceLang: 'en',
          );
          final badLength = translated.length != texts.length;
          final unchangedQuestion = translated.isNotEmpty &&
              translated[0].trim().toLowerCase() == sourceEntry.question.trim().toLowerCase();
          var allAnswersUnchanged = false;
          if (!badLength && translated.length == texts.length && translated.length > 1) {
            allAnswersUnchanged = true;
            for (var i = 0; i < sourceEntry.answers.length; i++) {
              final orig = sourceEntry.answers[i].trim().toLowerCase();
              final tr = translated[i + 1].trim().toLowerCase();
              if (orig != tr) {
                allAnswersUnchanged = false;
                break;
              }
            }
          }
          if (badLength || (unchangedQuestion && allAnswersUnchanged)) {
            fallbackDe++;
          } else {
            final entry = CardText(
              question: translated[0],
              answers: translated.sublist(1),
              correctIndex: sourceEntry.correctIndex,
              version: 1,
            );
            updated = CardModel(
              id: updated.id,
              question: updated.question,
              answers: updated.answers,
              correctAnswer: updated.correctAnswer,
              sourceLanguage: updated.sourceLanguage,
              languageMap: <String, CardText>{...updated.languageMap, 'de': entry},
              category: updated.category,
              difficulty: updated.difficulty,
              createdAt: updated.createdAt,
              source: updated.source,
            );
            translatedDe++;
          }
        } catch (e) {
          failCount++;
          debugPrint('IMPORT_TRANSLATION_FAIL card=${card.id} error=$e');
        }
      }

      if (!updated.languageMap.containsKey('es')) {
        try {
          final sourceForEs = updated.languageMap['en']!;
          final textsEs = [sourceForEs.question, ...sourceForEs.answers];
          final translated = await client.translateBatch(
            texts: textsEs,
            targetLang: 'es',
            sourceLang: 'en',
          );
          final badLength = translated.length != textsEs.length;
          final unchangedQuestion = translated.isNotEmpty &&
              translated[0].trim().toLowerCase() == sourceForEs.question.trim().toLowerCase();
          var allAnswersUnchanged = false;
          if (!badLength && translated.length == textsEs.length && translated.length > 1) {
            allAnswersUnchanged = true;
            for (var i = 0; i < sourceForEs.answers.length; i++) {
              final orig = sourceForEs.answers[i].trim().toLowerCase();
              final tr = translated[i + 1].trim().toLowerCase();
              if (orig != tr) {
                allAnswersUnchanged = false;
                break;
              }
            }
          }
          if (badLength || (unchangedQuestion && allAnswersUnchanged)) {
            fallbackEs++;
          } else {
            final entry = CardText(
              question: translated[0],
              answers: translated.sublist(1),
              correctIndex: sourceForEs.correctIndex,
              version: 1,
            );
            updated = CardModel(
              id: updated.id,
              question: updated.question,
              answers: updated.answers,
              correctAnswer: updated.correctAnswer,
              sourceLanguage: updated.sourceLanguage,
              languageMap: <String, CardText>{...updated.languageMap, 'es': entry},
              category: updated.category,
              difficulty: updated.difficulty,
              createdAt: updated.createdAt,
              source: updated.source,
            );
            translatedEs++;
          }
        } catch (e) {
          failCount++;
          debugPrint('IMPORT_TRANSLATION_FAIL card=${card.id} error=$e');
        }
      }

      result.add(updated);
    }

    if (translatedDe > 0) debugPrint('IMPORT_TRANSLATION_OK lang=de count=$translatedDe');
    if (translatedEs > 0) debugPrint('IMPORT_TRANSLATION_OK lang=es count=$translatedEs');
    if (fallbackDe > 0) debugPrint('IMPORT_TRANSLATION_FALLBACK lang=de count=$fallbackDe reason=unchanged_question');
    if (fallbackEs > 0) debugPrint('IMPORT_TRANSLATION_FALLBACK lang=es count=$fallbackEs reason=unchanged_question');
    if (failCount > 0) debugPrint('IMPORT_TRANSLATION_FAIL count=$failCount');
    return TranslateEnCardsResult(
      cards: result,
      failedCount: failCount,
      attemptedCount: enOnly.length,
    );
  }

  /// Full import pipeline: EN from opentdb.com + translate (de/es), merge.
  /// When total==0 or reason=='empty_db', runs bootstrap (cap kBootstrapEnCount, fail-ratio check).
  /// Returns result on success, null on failure. Never wipes storage on translation failure.
  Future<ImportPipelineResult?> runImportPipeline(
    TriviaImporter importer,
    String effectiveLang, {
    int total = 0,
    String reason = '',
  }) async {
    final stopwatch = Stopwatch()..start();
    final isBootstrap = total == 0 || reason == 'empty_db';
    final enCap = isBootstrap ? kBootstrapEnCount : kEnChunkPerRun;
    var totalNew = 0;
    try {
      if (isBootstrap) {
        debugPrint('BOOTSTRAP_START en=$kBootstrapEnCount');
      }
      final enCards = await importer.fetchEN(cap: enCap);
      final transResult = await translateEnCardsStrict(enCards);

      if (isBootstrap) {
        debugPrint(
          'BOOTSTRAP_TRANSLATION_OK kept=${transResult.cards.length} failed=${transResult.failedCount}',
        );
        if (transResult.attemptedCount > 0 &&
            transResult.failedCount / transResult.attemptedCount > kBootstrapMaxFailuresRatio) {
          debugPrint(
            'BOOTSTRAP_FAIL reason=too_many_failures ratio=${transResult.failedCount}/${transResult.attemptedCount}',
          );
          return null;
        }
        if (transResult.cards.isEmpty) {
          debugPrint('BOOTSTRAP_FAIL reason=no_cards_after_translation');
          return null;
        }
      }

      final mergeEn = await mergeAndPersistRaw(transResult.cards);
      totalNew += mergeEn.newCount;
      debugPrint('IMPORT_MERGE_DONE new=${mergeEn.newCount} total=${mergeEn.cards.length}');

      if (mergeEn.cards.isEmpty) {
        if (isBootstrap) debugPrint('BOOTSTRAP_FAIL reason=merge_empty');
        return null;
      }
      await _prefs.setBool(_importDoneKey, true);
      final all = await load();
      if (isBootstrap) {
        debugPrint('BOOTSTRAP_DONE total=${all.length}');
      }
      _logImportStats(all);
      stopwatch.stop();
      return ImportPipelineResult(
        newCount: totalNew,
        total: all.length,
        durationMs: stopwatch.elapsedMilliseconds,
      );
    } catch (e, st) {
      debugPrint('IMPORT_DONE_FAIL error=$e');
      if (isBootstrap) debugPrint('BOOTSTRAP_FAIL reason=$e');
      assert(() {
        debugPrint('$st');
        return true;
      }());
      return null;
    }
  }

  /// Merges [incoming] into existing storage and returns:
  /// - merged list (newest first)
  /// - number of *new* cards (by id)
  Future<MergeResult> mergeAndPersist(List<CardModel> incoming) async {
    final existing = await load();
    final byId = <String, CardModel>{
      for (final c in existing) c.id: c,
    };

    var newCount = 0;
    for (final incomingCard in incoming) {
      final current = byId[incomingCard.id];
      if (current == null) {
        newCount++;
        byId[incomingCard.id] = incomingCard;
        continue;
      }

      // Merge languageMap without overwriting existing entries; never overwrite sourceLanguage.
      final mergedLanguageMap = <String, CardText>{
        ...current.languageMap,
        ...incomingCard.languageMap.map((k, v) => MapEntry(k, current.languageMap[k] ?? v)),
      };
      byId[incomingCard.id] = CardModel(
        id: current.id,
        question: current.question,
        answers: current.answers,
        correctAnswer: current.correctAnswer,
        sourceLanguage: current.sourceLanguage,
        languageMap: mergedLanguageMap,
        category: current.category,
        difficulty: current.difficulty,
        createdAt: current.createdAt,
        source: current.source,
      );
    }

    var merged = byId.values.toList(growable: false)
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));

    // Import-only translation: fill missing languageMap[target] from languageMap[sourceLanguage].
    merged = await _fillMissingTranslationsOnImport(merged);

    // Import-only logging.
    _logImportStats(merged);

    await save(merged);
    return MergeResult(cards: merged, newCount: newCount);
  }

  Future<List<CardModel>> _fillMissingTranslationsOnImport(List<CardModel> cards) async {
    final client = createTranslationClient();
    final targets = _contentLanguages.toList(growable: false);

    final out = <CardModel>[];
    for (final c in cards) {
      var updated = c;
      final sourceLang = c.sourceLanguage.toLowerCase().trim();
      final sourceEntry = c.languageMap[sourceLang];
      if (sourceEntry == null) {
        out.add(updated);
        continue;
      }

      for (final target in targets) {
        if (target == sourceLang) continue;
        if (updated.languageMap.containsKey(target)) continue;

        final texts = <String>[sourceEntry.question, ...sourceEntry.answers];
        try {
          final translated = await client.translateBatch(
            texts: texts,
            targetLang: target,
            sourceLang: sourceLang,
          );
          if (translated.length != texts.length) continue;
          final joinedA = translated.join('\n').trim().toLowerCase();
          final joinedB = texts.join('\n').trim().toLowerCase();
          if (joinedA == joinedB) {
            // Worker rejected / returned originals. Keep missing -> fallback will show sourceLanguage.
            continue;
          }

          final entry = CardText(
            question: translated[0],
            answers: translated.sublist(1),
            correctIndex: sourceEntry.correctIndex,
            version: 1,
          );
          updated = CardModel(
            id: updated.id,
            question: updated.question,
            answers: updated.answers,
            correctAnswer: updated.correctAnswer,
            sourceLanguage: updated.sourceLanguage,
            languageMap: <String, CardText>{...updated.languageMap, target: entry},
            category: updated.category,
            difficulty: updated.difficulty,
            createdAt: updated.createdAt,
            source: updated.source,
          );
        } catch (_) {
          // Never crash import on translation failure; keep missing -> fallback.
        }
      }
      out.add(updated);
    }

    return out;
  }

  void _logImportStats(List<CardModel> cards) {
    try {
      final total = cards.length;
      final en = cards.where((c) => c.sourceLanguage == 'en').length;
      final de = cards.where((c) => c.sourceLanguage == 'de').length;
      debugPrint('SOURCE_LANGUAGE_STATS total=$total en=$en de=$de');
    } catch (_) {
      // Never crash on debug stats.
    }

    try {
      for (final lang in _contentLanguages.where((l) => l != 'en')) {
        var okQ = 0;
        var okA = 0;
        for (final c in cards) {
          final entry = c.languageMap[lang];
          if (entry != null) {
            if (entry.question.trim().isNotEmpty) okQ++;
            final sourceLen = c.languageMap[c.sourceLanguage]?.answers.length ?? c.answers.length;
            if (entry.answers.length == sourceLen) okA++;
          }
        }
        debugPrint('TRANSLATION_COVERAGE lang=$lang okQ=$okQ okA=$okA');
      }
    } catch (_) {
      // Never crash on coverage stats.
    }
  }

  /// Debug: prints DE native count, EN count, translated count, missing translations, broken cards.
  Future<void> runImportDiagnostics() async {
    try {
      final cards = await load();
      final deNative = cards.where((c) => c.sourceLanguage == 'de').length;
      final enCount = cards.where((c) => c.sourceLanguage == 'en').length;
      var withDe = 0;
      var withEs = 0;
      var missingQ = 0;
      var missingA = 0;
      var broken = 0;
      for (final c in cards) {
        final deEntry = c.languageMap['de'];
        final esEntry = c.languageMap['es'];
        if (deEntry != null) withDe++;
        if (esEntry != null) withEs++;
        if (c.sourceLanguage == 'en') {
          if (deEntry == null || deEntry.question.trim().isEmpty) missingQ++;
          if (deEntry == null || deEntry.answers.length != (c.languageMap['en']?.answers.length ?? c.answers.length)) missingA++;
        }
        final base = c.languageMap[c.sourceLanguage];
        if (base == null || base.answers.length < 2) broken++;
      }
      debugPrint('DIAGNOSTICS total=${cards.length} de_native=$deNative en=$enCount');
      debugPrint('DIAGNOSTICS translated de=$withDe es=$withEs');
      debugPrint('DIAGNOSTICS missing_translations q=$missingQ answers=$missingA broken_cards=$broken');
    } catch (e) {
      debugPrint('DIAGNOSTICS error=$e');
    }
  }
}

class TranslateEnCardsResult {
  const TranslateEnCardsResult({
    required this.cards,
    required this.failedCount,
    required this.attemptedCount,
  });
  final List<CardModel> cards;
  final int failedCount;
  final int attemptedCount;
}

class MergeResult {
  const MergeResult({
    required this.cards,
    required this.newCount,
    this.skippedCount = 0,
  });
  final List<CardModel> cards;
  final int newCount;
  final int skippedCount;
}

class ImportPipelineResult {
  const ImportPipelineResult({
    required this.newCount,
    required this.total,
    required this.durationMs,
  });
  final int newCount;
  final int total;
  final int durationMs;
}