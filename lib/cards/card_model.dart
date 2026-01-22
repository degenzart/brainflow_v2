import 'dart:convert';

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
  });

  final String id;
  final String question;
  final List<String> answers;
  final String correctAnswer;
  final String? category;
  final String? difficulty;
  final DateTime createdAt;
  final String? source;

  Map<String, Object?> toMap() => <String, Object?>{
        'id': id,
        'question': question,
        'answers': answers,
        'correctAnswer': correctAnswer,
        'category': category,
        'difficulty': difficulty,
        'createdAt': createdAt.toIso8601String(),
        'source': source,
      };

  static CardModel fromMap(Map<String, Object?> map) {
    return CardModel(
      id: map['id'] as String,
      question: map['question'] as String,
      answers: (map['answers'] as List<dynamic>).cast<String>(),
      correctAnswer: map['correctAnswer'] as String,
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

