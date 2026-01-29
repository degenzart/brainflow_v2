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

class CardModel {
  CardModel({
    required this.id,
    required this.question,
    required this.answers,
    required this.correctAnswer,
    this.sourceLanguage = 'en',
    Map<String, CardText>? languageMap,
    this.category,
    this.difficulty,
    required this.createdAt,
    this.source,
    // Legacy (pre-languageMap): accepted for seed/migration; merged into languageMap.
    Map<String, CardText>? translations,
  }) : languageMap = _ensureLanguageMap(
          sourceLanguage: sourceLanguage,
          question: question,
          answers: answers,
          correctAnswer: correctAnswer,
          languageMap: languageMap,
          translations: translations,
        );

  final String id;
  final String question;
  final List<String> answers;
  final String correctAnswer;
  /// Language of the *base* content fields (question/answers) for this card.
  /// ISO-ish lowercase language codes like 'en', 'de', 'es'. Defaults to 'en'.
  final String sourceLanguage;
  /// Canonical content storage: languageMap[lang] -> question + answers (+ correctIndex).
  /// The original language is always stored in languageMap[sourceLanguage].
  final Map<String, CardText> languageMap;
  final String? category;
  final String? difficulty;
  final DateTime createdAt;
  final String? source;

  static String _normalizeLanguageCode(Object? value) {
    final raw = (value is String ? value : '').trim().toLowerCase();
    if (raw.isEmpty) return 'en';
    // Very small validator: 2-5 letters or dash (e.g. 'pt', 'zh-cn').
    final ok = RegExp(r'^[a-z]{2,5}(-[a-z]{2,5})?$').hasMatch(raw);
    return ok ? raw : 'en';
  }

  static Map<String, CardText> _ensureLanguageMap({
    required String sourceLanguage,
    required String question,
    required List<String> answers,
    required String correctAnswer,
    Map<String, CardText>? languageMap,
    Map<String, CardText>? translations,
  }) {
    final normalizedSource = _normalizeLanguageCode(sourceLanguage);
    final correctIndex = answers.indexOf(correctAnswer);
    final baseText = CardText(
      question: question,
      answers: answers,
      correctIndex: correctIndex >= 0 ? correctIndex : 0,
      version: 1,
    );

    final merged = <String, CardText>{};
    if (languageMap != null) {
      languageMap.forEach((k, v) => merged[_normalizeLanguageCode(k)] = v);
    }
    if (translations != null) {
      translations.forEach((k, v) => merged[_normalizeLanguageCode(k)] = v);
    }

    // Always ensure original language entry exists.
    merged.putIfAbsent(normalizedSource, () => baseText);
    return merged;
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
      languageMap: languageMap,
      category: category,
      difficulty: difficulty,
      createdAt: createdAt,
      source: source,
    );
  }

  Map<String, Object?> toMap() => <String, Object?>{
        'id': id,
        'question': question,
        'answers': answers,
        'correctAnswer': correctAnswer,
        'sourceLanguage': sourceLanguage,
        'languageMap': languageMap.map(
          (key, value) => MapEntry(key, value.toMap()),
        ),
        'category': category,
        'difficulty': difficulty,
        'createdAt': createdAt.toIso8601String(),
        'source': source,
      };

  static CardModel fromMap(Map<String, Object?> map) {
    final normalizedSource = _normalizeLanguageCode(map['sourceLanguage']);

    // Preferred: languageMap (new format)
    Map<String, CardText>? languageMap;
    final lmRaw = map['languageMap'];
    if (lmRaw != null) {
      final lm = (lmRaw as Map).cast<String, Object?>();
      languageMap = lm.map(
        (key, value) => MapEntry(
          _normalizeLanguageCode(key),
          CardText.fromMap((value as Map).cast<String, Object?>()),
        ),
      );
    }

    // Legacy: translations (old format). Merge into languageMap if present.
    final trRaw = map['translations'];
    if (trRaw != null) {
      final transMap = (trRaw as Map).cast<String, Object?>();
      final legacy = transMap.map(
        (key, value) => MapEntry(
          _normalizeLanguageCode(key),
          CardText.fromMap((value as Map).cast<String, Object?>()),
        ),
      );
      languageMap = <String, CardText>{
        ...?languageMap,
        ...legacy,
      };
    }

    // Ensure original (sourceLanguage) exists in languageMap[sourceLanguage].
    final rawQuestion = map['question'] as String;
    final rawAnswers = (map['answers'] as List<dynamic>).cast<String>();
    final rawCorrectAnswer = map['correctAnswer'] as String;
    final correctIndex = rawAnswers.indexOf(rawCorrectAnswer);
    final baseText = CardText(
      question: rawQuestion,
      answers: rawAnswers,
      correctIndex: correctIndex >= 0 ? correctIndex : 0,
      version: 1,
    );
    final ensuredLanguageMap = <String, CardText>{
      if (languageMap != null) ...languageMap,
      if (!(languageMap?.containsKey(normalizedSource) ?? false))
        normalizedSource: baseText,
    };

    return CardModel(
      id: map['id'] as String,
      question: rawQuestion,
      answers: rawAnswers,
      correctAnswer: rawCorrectAnswer,
      sourceLanguage: normalizedSource,
      languageMap: ensuredLanguageMap,
      category: map['category'] as String?,
      difficulty: map['difficulty'] as String?,
      createdAt: DateTime.parse(map['createdAt'] as String),
      source: map['source'] as String?,
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

