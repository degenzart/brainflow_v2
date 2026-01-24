import 'dart:convert';
import 'dart:io';

import '../cards/card_model.dart';

class TriviaImporter {
  const TriviaImporter();

  static const _defaultAmount = 25;

  Future<List<CardModel>> fetch({int amount = _defaultAmount}) async {
    final client = HttpClient();
    try {
      final uri = Uri.https('opentdb.com', '/api.php', <String, String>{
        'amount': '$amount',
        'type': 'multiple',
      });

      final req = await client.getUrl(uri);
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      final res = await req.close();
      if (res.statusCode != 200) {
        throw HttpException('Unexpected status: ${res.statusCode}', uri: uri);
      }

      final body = await res.transform(utf8.decoder).join();
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      final responseCode = decoded['response_code'] as int?;
      if (responseCode != 0) {
        throw const FormatException('Open Trivia DB returned error.');
      }

      final results = (decoded['results'] as List<dynamic>).cast<Map>();
      final now = DateTime.now();

      return results.map((raw) {
        final map = raw.cast<String, dynamic>();
        final question = _decodeHtml(map['question'] as String);
        final correct = _decodeHtml(map['correct_answer'] as String);
        final incorrect =
            (map['incorrect_answers'] as List<dynamic>).cast<String>();
        final incorrectDecoded = incorrect.map(_decodeHtml).toList();

        final allAnswers = <String>[...incorrectDecoded, correct]..sort();

        return CardModel(
          id: _stableId(
            question: question,
            correctAnswer: correct,
            incorrectAnswers: incorrectDecoded,
          ),
          question: question,
          answers: allAnswers,
          correctAnswer: correct,
          sourceLanguage: 'en',
          category: _decodeHtml(map['category'] as String? ?? ''),
          difficulty: (map['difficulty'] as String?)?.toLowerCase(),
          createdAt: now,
          source: 'Open Trivia DB',
        );
      }).toList(growable: false);
    } finally {
      client.close(force: true);
    }
  }
}

String _stableId({
  required String question,
  required String correctAnswer,
  required List<String> incorrectAnswers,
}) {
  // FNV-1a 64-bit (stable across runs; no extra deps).
  const int fnvOffsetBasis = 0xcbf29ce484222325;
  const int fnvPrime = 0x100000001b3;

  int hash = fnvOffsetBasis;
  void add(String s) {
    final bytes = utf8.encode(s);
    for (final b in bytes) {
      hash ^= b;
      hash = (hash * fnvPrime) & 0xFFFFFFFFFFFFFFFF;
    }
    // separator
    hash ^= 0xFF;
    hash = (hash * fnvPrime) & 0xFFFFFFFFFFFFFFFF;
  }

  add(question);
  add(correctAnswer);
  for (final a in incorrectAnswers) {
    add(a);
  }

  final hex = hash.toRadixString(16).padLeft(16, '0');
  return 'trivia_$hex';
}

String _decodeHtml(String input) {
  var s = input;
  // Common named entities returned by Open Trivia DB.
  const named = <String, String>{
    '&quot;': '"',
    '&#039;': "'",
    '&apos;': "'",
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&nbsp;': ' ',
    '&ldquo;': '“',
    '&rdquo;': '”',
    '&lsquo;': '‘',
    '&rsquo;': '’',
    '&hellip;': '…',
  };
  named.forEach((k, v) => s = s.replaceAll(k, v));

  // Numeric decimal entities.
  s = s.replaceAllMapped(RegExp(r'&#(\d+);'), (m) {
    final code = int.tryParse(m[1] ?? '');
    if (code == null) return m[0] ?? '';
    return String.fromCharCode(code);
  });

  // Numeric hex entities.
  s = s.replaceAllMapped(RegExp(r'&#x([0-9a-fA-F]+);'), (m) {
    final code = int.tryParse(m[1] ?? '', radix: 16);
    if (code == null) return m[0] ?? '';
    return String.fromCharCode(code);
  });

  return s;
}

