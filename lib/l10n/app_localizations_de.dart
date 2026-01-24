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

  @override
  String get settings_section_general => 'Allgemein';

  @override
  String get settings_haptics => 'Haptik';

  @override
  String get settings_sound => 'Sound';

  @override
  String get settings_section_data => 'Daten';

  @override
  String get settings_reload_cards => 'Karten neu laden';

  @override
  String get settings_import_25 => 'Import: 25 Karten';

  @override
  String get settings_reset_local => 'Reset (lokal)';

  @override
  String get settings_section_legal => 'Rechtliches';

  @override
  String get settings_privacy => 'Datenschutz';

  @override
  String get settings_imprint => 'Impressum';

  @override
  String get settings_section_info => 'Info';

  @override
  String get settings_about => 'Über Brainflow';

  @override
  String get progress_training_title => 'Training';

  @override
  String get progress_difficulty => 'Schwierigkeit';

  @override
  String get progress_select_categories => 'Kategorien auswählen';

  @override
  String get account_title => 'Konto';

  @override
  String get account_section_profile => 'Profil';

  @override
  String get account_edit_profile => 'Profil bearbeiten';

  @override
  String get account_sign_in => 'Anmeldung';

  @override
  String get account_section_subscription => 'Abo';

  @override
  String get account_manage_subscription => 'Abo verwalten';

  @override
  String get account_restore_purchases => 'Käufe wiederherstellen';
}
