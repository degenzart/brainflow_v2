class TranslationBatchResult {
  const TranslationBatchResult({
    required this.translated,
    this.mode,
    this.rule,
    this.build,
  });

  final List<String> translated;
  final String? mode;
  final String? rule;
  final String? build;
}

