// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Spanish Castilian (`es`).
class AppLocalizationsEs extends AppLocalizations {
  AppLocalizationsEs([String locale = 'es']) : super(locale);

  @override
  String get drawer_flow => 'FLOW';

  @override
  String get drawer_sprint => 'SPRINT';

  @override
  String get drawer_run => 'RUN';

  @override
  String get drawer_progress => 'PROGRESS';

  @override
  String get menu_account => 'Cuenta';

  @override
  String get menu_settings => 'Ajustes';

  @override
  String get menu_language => 'Idioma';

  @override
  String get import_title => 'Importación en línea';

  @override
  String get import_subtitle => 'Open Trivia DB (25 preguntas)';

  @override
  String get import_running => 'Importando…';

  @override
  String import_done(int count) {
    return 'Importación lista: $count nuevas tarjetas.';
  }

  @override
  String get no_cards_loaded => 'Aún no hay tarjetas cargadas.';

  @override
  String get report_title => 'Reportar';

  @override
  String get report_too_hard => 'Demasiado difícil';

  @override
  String get report_too_easy => 'Demasiado fácil';

  @override
  String get report_wrong_unclear => 'Incorrecto / poco claro';
}
