import 'dart:convert';

class CardText {
  const CardText({
    required this.question,
    required this.answers,
    required this.correctIndex,
    required this.version,
  });

  final String question;
  final List<String> answers;
  final int correctIndex;
  final int version;

  Map<String, Object?> toMap() => <String, Object?>{
        'question': question,
        'answers': answers,
        'correctIndex': correctIndex,
        'version': version,
      };

  static CardText fromMap(Map<String, Object?> map) {
    return CardText(
      question: map['question'] as String,
      answers: (map['answers'] as List<dynamic>).cast<String>(),
      correctIndex: map['correctIndex'] as int,
      version: map['version'] as int,
    );
  }
}

enum CardOriginType {
  original,
  translated,
  mixed,
  unknown,
}

class CardModel {
  const CardModel({
    required this.id,
    required this.question,
    required this.answers,
    required this.correctAnswer,
    this.sourceLanguage = 'en',
    this.originType = CardOriginType.unknown,
    this.category,
    this.difficulty,
    required this.createdAt,
    this.source,
    this.translations,
  });

  final String id;
  final String question;
  final List<String> answers;
  final String correctAnswer;
  /// Language of the *base* content fields (question/answers) for this card.
  /// ISO-ish lowercase language codes like 'en', 'de', 'es'. Defaults to 'en'.
  final String sourceLanguage;
  /// Marker describing where this card's content comes from.
  ///
  /// - original: content is native/original for [sourceLanguage]
  /// - translated: at least one machine translation exists (via worker)
  /// - mixed: partial translation (reserved for future)
  /// - unknown: legacy/fallback
  final CardOriginType originType;
  final String? category;
  final String? difficulty;
  final DateTime createdAt;
  final String? source;
  final Map<String, CardText>? translations;

  static String _normalizeLanguageCode(Object? value) {
    final raw = (value is String ? value : '').trim().toLowerCase();
    if (raw.isEmpty) return 'en';
    // Very small validator: 2-5 letters or dash (e.g. 'pt', 'zh-cn').
    final ok = RegExp(r'^[a-z]{2,5}(-[a-z]{2,5})?$').hasMatch(raw);
    return ok ? raw : 'en';
  }

  static CardOriginType _parseOriginType(Object? value) {
    final raw = (value is String ? value : '').trim().toLowerCase();
    switch (raw) {
      case 'original':
        return CardOriginType.original;
      case 'translated':
        return CardOriginType.translated;
      case 'mixed':
        return CardOriginType.mixed;
      case 'unknown':
      default:
        return CardOriginType.unknown;
    }
  }

  CardModel withSourceLanguage(String languageCode) {
    final normalized = _normalizeLanguageCode(languageCode);
    if (normalized == sourceLanguage) return this;
    return CardModel(
      id: id,
      question: question,
      answers: answers,
      correctAnswer: correctAnswer,
      sourceLanguage: normalized,
      originType: originType,
      category: category,
      difficulty: difficulty,
      createdAt: createdAt,
      source: source,
      translations: translations,
    );
  }

  CardModel withOriginType(CardOriginType type) {
    if (type == originType) return this;
    return CardModel(
      id: id,
      question: question,
      answers: answers,
      correctAnswer: correctAnswer,
      sourceLanguage: sourceLanguage,
      originType: type,
      category: category,
      difficulty: difficulty,
      createdAt: createdAt,
      source: source,
      translations: translations,
    );
  }

  Map<String, Object?> toMap() => <String, Object?>{
        'id': id,
        'question': question,
        'answers': answers,
        'correctAnswer': correctAnswer,
        'sourceLanguage': sourceLanguage,
        'originType': originType.name,
        'category': category,
        'difficulty': difficulty,
        'createdAt': createdAt.toIso8601String(),
        'source': source,
        if (translations != null)
          'translations': translations!.map(
            (key, value) => MapEntry(key, value.toMap()),
          ),
      };

  static CardModel fromMap(Map<String, Object?> map) {
    Map<String, CardText>? translations;
    if (map['translations'] != null) {
      final transMap = map['translations'] as Map<String, dynamic>;
      translations = transMap.map(
        (key, value) => MapEntry(
          key,
          CardText.fromMap((value as Map).cast<String, Object?>()),
        ),
      );
    }

    return CardModel(
      id: map['id'] as String,
      question: map['question'] as String,
      answers: (map['answers'] as List<dynamic>).cast<String>(),
      correctAnswer: map['correctAnswer'] as String,
      sourceLanguage: _normalizeLanguageCode(map['sourceLanguage']),
      originType: _parseOriginType(map['originType']),
      category: map['category'] as String?,
      difficulty: map['difficulty'] as String?,
      createdAt: DateTime.parse(map['createdAt'] as String),
      source: map['source'] as String?,
      translations: translations,
    );
  }

  static List<CardModel> decodeList(String jsonString) {
    final decoded = jsonDecode(jsonString) as List<dynamic>;
    return decoded
        .map((e) => CardModel.fromMap((e as Map).cast<String, Object?>()))
        .toList(growable: false);
  }

  static String encodeList(List<CardModel> cards) {
    final payload = cards.map((c) => c.toMap()).toList(growable: false);
    return jsonEncode(payload);
  }
}

