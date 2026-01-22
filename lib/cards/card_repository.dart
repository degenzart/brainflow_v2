import 'package:shared_preferences/shared_preferences.dart';

import 'card_model.dart';

class CardRepository {
  CardRepository(this._prefs);

  static const String _cardsKey = 'cards_v1';

  final SharedPreferences _prefs;

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

