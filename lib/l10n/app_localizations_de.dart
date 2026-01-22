// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for German (`de`).
class AppLocalizationsDe extends AppLocalizations {
  AppLocalizationsDe([String locale = 'de']) : super(locale);

  @override
  String get drawer_flow => 'FLOW';

  @override
  String get drawer_sprint => 'SPRINT';

  @override
  String get drawer_run => 'RUN';

  @override
  String get drawer_progress => 'PROGRESS';

  @override
  String get menu_account => 'Konto';

  @override
  String get menu_settings => 'Einstellungen';

  @override
  String get menu_language => 'Sprache';

  @override
  String get import_title => 'Online-Import';

  @override
  String get import_subtitle => 'Open Trivia DB (25 Fragen)';

  @override
  String get import_running => 'Import läuft…';

  @override
  String import_done(int count) {
    return 'Import fertig: $count neue Karten.';
  }

  @override
  String get no_cards_loaded => 'Noch keine Karten geladen.';

  @override
  String get report_title => 'Melden';

  @override
  String get report_too_hard => 'Zu schwer';

  @override
  String get report_too_easy => 'Zu leicht';

  @override
  String get report_wrong_unclear => 'Falsch / unklar';
}
