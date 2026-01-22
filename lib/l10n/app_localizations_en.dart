// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get drawer_flow => 'FLOW';

  @override
  String get drawer_sprint => 'SPRINT';

  @override
  String get drawer_run => 'RUN';

  @override
  String get drawer_progress => 'PROGRESS';

  @override
  String get menu_account => 'Account';

  @override
  String get menu_settings => 'Settings';

  @override
  String get menu_language => 'Language';

  @override
  String get import_title => 'Online import';

  @override
  String get import_subtitle => 'Open Trivia DB (25 questions)';

  @override
  String get import_running => 'Import running…';

  @override
  String import_done(int count) {
    return 'Import done: $count new cards.';
  }

  @override
  String get no_cards_loaded => 'No cards loaded yet.';

  @override
  String get report_title => 'Report';

  @override
  String get report_too_hard => 'Too hard';

  @override
  String get report_too_easy => 'Too easy';

  @override
  String get report_wrong_unclear => 'Wrong / unclear';
}
