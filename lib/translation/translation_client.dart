abstract class TranslationClient {
  /// Translates [text] into [targetLang].
  ///
  /// - [targetLang] should be a language code like 'es', 'de', 'fr'
  /// - [sourceLang] defaults to 'auto'
  Future<String> translate({
    required String text,
    required String targetLang,
    String sourceLang = 'auto',
  });

  /// Translates a batch of texts into [targetLang] in one call.
  ///
  /// The returned list must have the same length and order as [texts].
  Future<List<String>> translateBatch({
    required List<String> texts,
    required String targetLang,
    String sourceLang = 'auto',
  });
}

