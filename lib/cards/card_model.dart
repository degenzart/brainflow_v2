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
  const CardModel({
    required this.id,
    required this.question,
    required this.answers,
    required this.correctAnswer,
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
  final String? category;
  final String? difficulty;
  final DateTime createdAt;
  final String? source;
  final Map<String, CardText>? translations;

  Map<String, Object?> toMap() => <String, Object?>{
        'id': id,
        'question': question,
        'answers': answers,
        'correctAnswer': correctAnswer,
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

