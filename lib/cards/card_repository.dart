import 'package:shared_preferences/shared_preferences.dart';

import 'card_model.dart';
import 'seed_cards.dart';
import '../translation/proxy_translation_client.dart';

class CardRepository {
  CardRepository(this._prefs);

  static final Uri _translationWorkerBaseUrl =
      Uri.parse('https://brainflow-translate.bjdybkw57j.workers.dev');

  static const String _cardsKey = 'cards_v1';
  static const String _seedPersistedKey = 'seed_persisted_v1';

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
    final targetLang = localeCode
        .toLowerCase()
        .trim()
        .replaceAll('_', '-')
        .split('-')
        .first;
    final sourcePrimary = raw.sourceLanguage
        .toLowerCase()
        .trim()
        .replaceAll('_', '-')
        .split('-')
        .first;

    // Fast-path: if target matches the base content language, we can return raw.
    if (targetLang.isNotEmpty && sourcePrimary.isNotEmpty && targetLang == sourcePrimary) {
      return raw;
    }

    if (raw.translations != null && raw.translations!.containsKey(targetLang)) {
      final translation = raw.translations![targetLang]!;
      final correctAnswer = translation.answers[translation.correctIndex];

      return CardModel(
        id: raw.id,
        question: translation.question,
        answers: translation.answers,
        correctAnswer: correctAnswer,
        sourceLanguage: raw.sourceLanguage,
        originType: raw.originType,
        category: raw.category,
        difficulty: raw.difficulty,
        createdAt: raw.createdAt,
        source: raw.source,
        translations: raw.translations, // Keep translations for future use
      );
    }

    // Fallback to original card
    return raw;
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
    for (final c in incoming) {
      if (!byId.containsKey(c.id)) newCount++;
      byId[c.id] = c;
    }

    final merged = byId.values.toList(growable: false)
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));

    await save(merged);
    return MergeResult(cards: merged, newCount: newCount);
  }
}

class MergeResult {
  const MergeResult({required this.cards, required this.newCount});
  final List<CardModel> cards;
  final int newCount;
}
