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

  @override
  String get settings_section_general => 'General';

  @override
  String get settings_haptics => 'Haptics';

  @override
  String get settings_sound => 'Sound';

  @override
  String get settings_section_data => 'Data';

  @override
  String get settings_reload_cards => 'Reload cards';

  @override
  String get settings_import_25 => 'Import: 25 cards';

  @override
  String get settings_reset_local => 'Reset (local)';

  @override
  String get settings_section_legal => 'Legal';

  @override
  String get settings_privacy => 'Privacy';

  @override
  String get settings_imprint => 'Imprint';

  @override
  String get settings_section_info => 'Info';

  @override
  String get settings_about => 'About Brainflow';

  @override
  String get progress_training_title => 'Training';

  @override
  String get progress_difficulty => 'Difficulty';

  @override
  String get progress_select_categories => 'Select categories';

  @override
  String get account_title => 'Account';

  @override
  String get account_section_profile => 'Profile';

  @override
  String get account_edit_profile => 'Edit profile';

  @override
  String get account_sign_in => 'Sign in';

  @override
  String get account_section_subscription => 'Subscription';

  @override
  String get account_manage_subscription => 'Manage subscription';

  @override
  String get account_restore_purchases => 'Restore purchases';
}
