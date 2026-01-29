import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/foundation.dart' show debugPrint;

import 'card_model.dart';
import 'seed_cards.dart';
import '../translation/proxy_translation_client.dart';

class CardRepository {
  CardRepository(this._prefs);

  static final Uri _translationWorkerBaseUrl =
      Uri.parse('https://brainflow-translate.bjdybkw57j.workers.dev');

  static const String _cardsKey = 'cards_v1';
  static const String _seedPersistedKey = 'seed_persisted_v1';
  static const List<String> _contentLanguages = <String>['en', 'de', 'es'];

  final SharedPreferences _prefs;

  ProxyTranslationClient createTranslationClient() {
    return ProxyTranslationClient(baseUrl: _translationWorkerBaseUrl);
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

  /// Ensures seed cards are persisted if storage is empty
  Future<void> ensureSeed() async {
    final existing = await load();
    if (existing.isNotEmpty) return; // Already has cards

    final seedPersisted = _prefs.getBool(_seedPersistedKey) ?? false;
    if (seedPersisted) return; // Seed already persisted

    // Persist seed cards
    await save(seedCards);
    await _prefs.setBool(_seedPersistedKey, true);
  }

  /// Resolves a card for a specific locale
  /// Returns a new CardModel with question/answers/correctAnswer from translation if available
  CardModel resolveForLocale(CardModel raw, String localeCode) {
    // Normalize locale code (e.g., 'en_US' -> 'en')
    final targetLang = localeCode.split('_').first.toLowerCase().trim();

    final baseEntry = raw.languageMap[raw.sourceLanguage];
    final targetEntry = (targetLang.isNotEmpty) ? raw.languageMap[targetLang] : null;
    final resolved = targetEntry ?? baseEntry;
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

  /// Placeholder for future server download
  /// Called when remaining/total < 0.30
  Future<void> maybeDownloadMoreIfLow({
    required String localeCode,
    required int remaining,
    required int total,
  }) async {
    // TODO: Implement server download when ready
    // This is a placeholder that does nothing for now
    if (remaining / total < 0.30) {
      // Would trigger download here
    }
  }

  Future<void> save(List<CardModel> cards) async {
    await _prefs.setString(_cardsKey, CardModel.encodeList(cards));
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
      final counts = <String, int>{};
      for (final c in cards) {
        final code = c.sourceLanguage.toLowerCase().trim();
        counts[code] = (counts[code] ?? 0) + 1;
      }
      debugPrint('SOURCE_LANGUAGE STATS: total=$total ${counts.entries.map((e) => '${e.key}=${e.value}').join(', ')}');
    } catch (_) {
      // Never crash on debug stats.
    }

    try {
      final total = cards.length;
      for (final lang in _contentLanguages.where((l) => l != 'en')) {
        var hasLang = 0;
        var okQ = 0;
        var okA = 0;
        for (final c in cards) {
          final entry = c.languageMap[lang];
          if (entry != null) {
            hasLang++;
            if (entry.question.trim().isNotEmpty) okQ++;
            if (entry.answers.length == (c.languageMap[c.sourceLanguage]?.answers.length ?? c.answers.length)) {
              okA++;
            }
          }
        }
        debugPrint(
          'TRANSLATION_COVERAGE: lang=$lang hasLang=$hasLang/$total okQ=$okQ/$total okA=$okA/$total',
        );
      }
    } catch (_) {
      // Never crash on coverage stats.
    }
  }
}

class MergeResult {
  const MergeResult({required this.cards, required this.newCount});
  final List<CardModel> cards;
  final int newCount;
}
