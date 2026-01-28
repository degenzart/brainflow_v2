import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;

/// Decodes HTML entities in a string to their Unicode equivalents.
///
/// Supports:
/// - Named entities (e.g., &amp;, &quot;, &eacute;)
/// - Numeric decimal entities (e.g., &#233;)
/// - Numeric hexadecimal entities (e.g., &#xE9;)
///
/// Returns the decoded string. If decoding occurs and [cardId] and [field] are provided,
/// logs a debug message.
String decodeHtmlEntities(
  String input, {
  String? cardId,
  String? field,
}) {
  if (input.isEmpty) return input;

  // Check if input contains any HTML entities
  if (!input.contains('&')) return input;

  var s = input;
  var wasDecoded = false;

  // Common named entities (extended list)
  const named = <String, String>{
    // Basic entities
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    // Quotes
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&lsquo;': ''',
    '&rsquo;': ''',
    // Spaces and punctuation
    '&nbsp;': ' ',
    '&hellip;': '…',
    '&mdash;': '—',
    '&ndash;': '–',
    // Accented characters (common)
    '&eacute;': 'é',
    '&Eacute;': 'É',
    '&agrave;': 'à',
    '&Agrave;': 'À',
    '&egrave;': 'è',
    '&Egrave;': 'È',
    '&ecirc;': 'ê',
    '&Ecirc;': 'Ê',
    '&euml;': 'ë',
    '&Euml;': 'Ë',
    '&iacute;': 'í',
    '&Iacute;': 'Í',
    '&oacute;': 'ó',
    '&Oacute;': 'Ó',
    '&ouml;': 'ö',
    '&Ouml;': 'Ö',
    '&uuml;': 'ü',
    '&Uuml;': 'Ü',
    '&aacute;': 'á',
    '&Aacute;': 'Á',
    '&ntilde;': 'ñ',
    '&Ntilde;': 'Ñ',
    '&ccedil;': 'ç',
    '&Ccedil;': 'Ç',
    // Special characters
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&deg;': '°',
    '&frac12;': '½',
    '&frac14;': '¼',
    '&frac34;': '¾',
    '&frac18;': '⅛',
    '&frac38;': '⅜',
    '&frac58;': '⅝',
    '&frac78;': '⅞',
  };

  // Decode named entities
  for (final entry in named.entries) {
    if (s.contains(entry.key)) {
      s = s.replaceAll(entry.key, entry.value);
      wasDecoded = true;
    }
  }

  // Numeric decimal entities (e.g., &#233;)
  s = s.replaceAllMapped(RegExp(r'&#(\d+);'), (m) {
    final code = int.tryParse(m[1] ?? '');
    if (code == null || code < 0 || code > 0x10FFFF) return m[0] ?? '';
    wasDecoded = true;
    return String.fromCharCode(code);
  });

  // Numeric hexadecimal entities (e.g., &#xE9; or &#xe9;)
  s = s.replaceAllMapped(RegExp(r'&#x([0-9a-fA-F]+);'), (m) {
    final code = int.tryParse(m[1] ?? '', radix: 16);
    if (code == null || code < 0 || code > 0x10FFFF) return m[0] ?? '';
    wasDecoded = true;
    return String.fromCharCode(code);
  });

  // Log if decoding occurred
  if (wasDecoded && kDebugMode && cardId != null && field != null) {
    debugPrint('HTML_ENTITY_DECODED: card=$cardId field=$field');
  }

  return s;
}
