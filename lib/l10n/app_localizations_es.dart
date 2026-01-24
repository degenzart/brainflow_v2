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

  @override
  String get settings_section_general => 'General';

  @override
  String get settings_haptics => 'Háptica';

  @override
  String get settings_sound => 'Sonido';

  @override
  String get settings_section_data => 'Datos';

  @override
  String get settings_reload_cards => 'Recargar tarjetas';

  @override
  String get settings_import_25 => 'Importar: 25 tarjetas';

  @override
  String get settings_reset_local => 'Restablecer (local)';

  @override
  String get settings_section_legal => 'Legal';

  @override
  String get settings_privacy => 'Privacidad';

  @override
  String get settings_imprint => 'Aviso legal';

  @override
  String get settings_section_info => 'Info';

  @override
  String get settings_about => 'Acerca de Brainflow';

  @override
  String get progress_training_title => 'Entrenamiento';

  @override
  String get progress_difficulty => 'Dificultad';

  @override
  String get progress_select_categories => 'Seleccionar categorías';

  @override
  String get account_title => 'Cuenta';

  @override
  String get account_section_profile => 'Perfil';

  @override
  String get account_edit_profile => 'Editar perfil';

  @override
  String get account_sign_in => 'Iniciar sesión';

  @override
  String get account_section_subscription => 'Suscripción';

  @override
  String get account_manage_subscription => 'Administrar suscripción';

  @override
  String get account_restore_purchases => 'Restaurar compras';
}
