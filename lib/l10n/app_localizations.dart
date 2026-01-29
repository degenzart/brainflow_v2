import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_de.dart';
import 'app_localizations_en.dart';
import 'app_localizations_es.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations? of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('de'),
    Locale('en'),
    Locale('es'),
  ];

  /// No description provided for @drawer_flow.
  ///
  /// In en, this message translates to:
  /// **'FLOW'**
  String get drawer_flow;

  /// No description provided for @drawer_sprint.
  ///
  /// In en, this message translates to:
  /// **'SPRINT'**
  String get drawer_sprint;

  /// No description provided for @drawer_run.
  ///
  /// In en, this message translates to:
  /// **'RUN'**
  String get drawer_run;

  /// No description provided for @drawer_progress.
  ///
  /// In en, this message translates to:
  /// **'PROGRESS'**
  String get drawer_progress;

  /// No description provided for @menu_account.
  ///
  /// In en, this message translates to:
  /// **'Account'**
  String get menu_account;

  /// No description provided for @menu_settings.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get menu_settings;

  /// No description provided for @menu_language.
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get menu_language;

  /// No description provided for @import_title.
  ///
  /// In en, this message translates to:
  /// **'Online import'**
  String get import_title;

  /// No description provided for @import_subtitle.
  ///
  /// In en, this message translates to:
  /// **'Open Trivia DB (25 questions)'**
  String get import_subtitle;

  /// No description provided for @import_running.
  ///
  /// In en, this message translates to:
  /// **'Import running…'**
  String get import_running;

  /// Shown after import finished.
  ///
  /// In en, this message translates to:
  /// **'Import done: {count} new cards.'**
  String import_done(int count);

  /// No description provided for @no_cards_loaded.
  ///
  /// In en, this message translates to:
  /// **'No cards found, starting import.'**
  String get no_cards_loaded;

  /// No description provided for @report_title.
  ///
  /// In en, this message translates to:
  /// **'Report'**
  String get report_title;

  /// No description provided for @report_too_hard.
  ///
  /// In en, this message translates to:
  /// **'Too hard'**
  String get report_too_hard;

  /// No description provided for @report_too_easy.
  ///
  /// In en, this message translates to:
  /// **'Too easy'**
  String get report_too_easy;

  /// No description provided for @report_wrong_unclear.
  ///
  /// In en, this message translates to:
  /// **'Wrong / unclear'**
  String get report_wrong_unclear;

  /// No description provided for @settings_section_general.
  ///
  /// In en, this message translates to:
  /// **'General'**
  String get settings_section_general;

  /// No description provided for @settings_haptics.
  ///
  /// In en, this message translates to:
  /// **'Haptics'**
  String get settings_haptics;

  /// No description provided for @settings_sound.
  ///
  /// In en, this message translates to:
  /// **'Sound'**
  String get settings_sound;

  /// No description provided for @settings_section_data.
  ///
  /// In en, this message translates to:
  /// **'Data'**
  String get settings_section_data;

  /// No description provided for @settings_reload_cards.
  ///
  /// In en, this message translates to:
  /// **'Reload cards'**
  String get settings_reload_cards;

  /// No description provided for @settings_import_25.
  ///
  /// In en, this message translates to:
  /// **'Import: 25 cards'**
  String get settings_import_25;

  /// No description provided for @settings_reset_local.
  ///
  /// In en, this message translates to:
  /// **'Reset (local)'**
  String get settings_reset_local;

  /// No description provided for @settings_section_legal.
  ///
  /// In en, this message translates to:
  /// **'Legal'**
  String get settings_section_legal;

  /// No description provided for @settings_privacy.
  ///
  /// In en, this message translates to:
  /// **'Privacy'**
  String get settings_privacy;

  /// No description provided for @settings_imprint.
  ///
  /// In en, this message translates to:
  /// **'Imprint'**
  String get settings_imprint;

  /// No description provided for @settings_section_info.
  ///
  /// In en, this message translates to:
  /// **'Info'**
  String get settings_section_info;

  /// No description provided for @settings_about.
  ///
  /// In en, this message translates to:
  /// **'About Brainflow'**
  String get settings_about;

  /// No description provided for @progress_training_title.
  ///
  /// In en, this message translates to:
  /// **'Training'**
  String get progress_training_title;

  /// No description provided for @progress_difficulty.
  ///
  /// In en, this message translates to:
  /// **'Difficulty'**
  String get progress_difficulty;

  /// No description provided for @progress_select_categories.
  ///
  /// In en, this message translates to:
  /// **'Select categories'**
  String get progress_select_categories;

  /// No description provided for @account_title.
  ///
  /// In en, this message translates to:
  /// **'Account'**
  String get account_title;

  /// No description provided for @account_section_profile.
  ///
  /// In en, this message translates to:
  /// **'Profile'**
  String get account_section_profile;

  /// No description provided for @account_edit_profile.
  ///
  /// In en, this message translates to:
  /// **'Edit profile'**
  String get account_edit_profile;

  /// No description provided for @account_sign_in.
  ///
  /// In en, this message translates to:
  /// **'Sign in'**
  String get account_sign_in;

  /// No description provided for @account_section_subscription.
  ///
  /// In en, this message translates to:
  /// **'Subscription'**
  String get account_section_subscription;

  /// No description provided for @account_manage_subscription.
  ///
  /// In en, this message translates to:
  /// **'Manage subscription'**
  String get account_manage_subscription;

  /// No description provided for @account_restore_purchases.
  ///
  /// In en, this message translates to:
  /// **'Restore purchases'**
  String get account_restore_purchases;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['de', 'en', 'es'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'de':
      return AppLocalizationsDe();
    case 'en':
      return AppLocalizationsEn();
    case 'es':
      return AppLocalizationsEs();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
