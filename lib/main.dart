import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/rendering.dart'
    show
        debugPaintSizeEnabled,
        debugPaintBaselinesEnabled,
        debugPaintPointersEnabled,
        debugPaintLayerBordersEnabled,
        debugRepaintRainbowEnabled;

import 'l10n/app_localizations.dart';
import 'cards/card_model.dart';
import 'cards/card_repository.dart';
import 'import/trivia_importer.dart';

void _forceDisableDebugPaint() {
  // These globals are toggled by the Flutter Inspector “Debug Paint”.
  // We keep forcing them off so the UI doesn’t show purple outlines/borders.
  debugPaintSizeEnabled = false;
  debugPaintBaselinesEnabled = false;
  debugPaintPointersEnabled = false;
  debugPaintLayerBordersEnabled = false;
  debugRepaintRainbowEnabled = false;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Ensure no debug paint overlays are enabled (purple outlines, etc.).
  _forceDisableDebugPaint();

  // If the Flutter Inspector toggled Debug Paint ON, it can re-enable after startup.
  // In debug builds, keep forcing it OFF for a few seconds.
  assert(() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _forceDisableDebugPaint();
    });
    var ticks = 0;
    Timer.periodic(const Duration(milliseconds: 250), (t) {
      _forceDisableDebugPaint();
      ticks++;
      if (ticks >= 40) t.cancel(); // ~10 seconds
    });
    return true;
  }());

  final prefs = await SharedPreferences.getInstance();
  final localeController = LocaleController(prefs)..loadFromPrefs();
  final repository = CardRepository(prefs);
  runApp(
    BrainflowApp(localeController: localeController, repository: repository),
  );
}

class BrainflowApp extends StatelessWidget {
  const BrainflowApp({
    super.key,
    required this.localeController,
    required this.repository,
  });

  final LocaleController localeController;
  final CardRepository repository;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: localeController,
      builder: (context, _) {
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          title: 'Brainflow',
          theme: ThemeData(
            useMaterial3: true,
            brightness: Brightness.dark,
            colorSchemeSeed: const Color(0xFF8B5CF6),
          ),
          locale: localeController.locale,
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: AppLocalizations.supportedLocales,
          localeResolutionCallback: (locale, supportedLocales) {
            if (locale == null) return const Locale('en');
            for (final supported in supportedLocales) {
              if (supported.languageCode == locale.languageCode) {
                return supported;
              }
            }
            return const Locale('en');
          },
          home: HomeScreen(
            repository: repository,
            localeController: localeController,
          ),
        );
      },
    );
  }
}

class LocaleController extends ChangeNotifier {
  LocaleController(this._prefs);

  static const _prefsKey = 'locale_v1'; // 'system' | 'en' | 'de' | 'es'

  final SharedPreferences _prefs;
  Locale? _locale; // null means "system"

  Locale? get locale => _locale;

  void loadFromPrefs() {
    final code = _prefs.getString(_prefsKey) ?? 'system';
    _locale = _localeFromCode(code);
  }

  Future<void> setLocaleCode(String code) async {
    _locale = _localeFromCode(code);
    await _prefs.setString(_prefsKey, code);
    notifyListeners();
  }

  static Locale? _localeFromCode(String code) {
    switch (code) {
      case 'system':
        return null;
      case 'en':
      case 'de':
      case 'es':
        return Locale(code);
      default:
        return null;
    }
  }

  String get currentCode => _locale?.languageCode ?? 'system';
}

enum DrawerSection { flow, sprint, run, progress }

class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.repository,
    required this.localeController,
  });

  final CardRepository repository;
  final LocaleController localeController;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _importer = const TriviaImporter();
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  static bool _didLogAddedTranslationsCount = false;
  static final Set<String> _didLogTranslationPersistForLang = <String>{};

  var _section = DrawerSection.flow;
  var _loading = true;
  List<CardModel> _cards = const <CardModel>[];
  bool _persistingTranslations = false;

  // Settings state
  bool _hapticsEnabled = true;
  bool _soundEnabled = true;
  String _difficulty = 'medium';

  @override
  void initState() {
    super.initState();
    _loadCards();
    // Reload cards when locale changes
    widget.localeController.addListener(_onLocaleChanged);
  }

  @override
  void dispose() {
    widget.localeController.removeListener(_onLocaleChanged);
    super.dispose();
  }

  void _onLocaleChanged() {
    _loadCards();
  }

  Future<void> _loadCards() async {
    // Ensure seed cards are persisted if storage is empty
    await widget.repository.ensureSeed();

    // Load raw cards
    final rawCards = await widget.repository.load();
    if (!mounted) return;

    final systemLanguageCode =
        WidgetsBinding.instance.platformDispatcher.locale.languageCode;
    final currentLanguageCode =
        (widget.localeController.locale?.languageCode ?? systemLanguageCode)
            .toLowerCase();
    final effectiveLanguageCode = currentLanguageCode.isEmpty
        ? 'en'
        : currentLanguageCode;

    // Resolve cards for current locale
    final resolvedCards = rawCards
        .map(
          (card) =>
              widget.repository.resolveForLocale(card, effectiveLanguageCode),
        )
        .toList(growable: false);

    // Check if we need to download more (placeholder for future)
    final total = resolvedCards.length;
    final remaining = total; // In real implementation, track remaining cards
    if (total > 0) {
      await widget.repository.maybeDownloadMoreIfLow(
        localeCode: effectiveLanguageCode,
        remaining: remaining,
        total: total,
      );
    }

    setState(() {
      _cards = resolvedCards;
      _loading = false;
    });

    // Background: persist missing translations for the active language.
    unawaited(
      _persistMissingTranslationsIfNeeded(
        rawCards: rawCards,
        targetLang: effectiveLanguageCode,
      ),
    );
  }

  Future<void> _persistMissingTranslationsIfNeeded({
    required List<CardModel> rawCards,
    required String targetLang,
  }) async {
    if (_persistingTranslations) return;

    final lang = targetLang.split('_').first.toLowerCase().trim();
    if (lang.isEmpty || lang == 'en' || lang == 'system') return;

    // Quick pre-check: do we have any card that actually needs a translation?
    final needsAny = rawCards.any((c) {
      if (lang == c.sourceLanguage) return false;
      final t = c.translations;
      return t == null || !t.containsKey(lang);
    });
    if (!needsAny) return;

    _persistingTranslations = true;
    var addedTranslationsCount = 0;

    try {
      final client = widget.repository.createTranslationClient();
      final updatedCards = <CardModel>[];
      var changed = false;

      for (final card in rawCards) {
        // Never translate if targetLang equals source language.
        if (lang == card.sourceLanguage) {
          updatedCards.add(card);
          continue;
        }

        final existing = card.translations;
        if (existing != null && existing.containsKey(lang)) {
          updatedCards.add(card);
          continue;
        }

        final texts = <String>[card.question, ...card.answers];

        List<String> translated;
        try {
          translated = await client.translateBatch(
            texts: texts,
            targetLang: lang,
            sourceLang: 'auto',
          );
        } catch (_) {
          // Failsafe: do not persist on failure.
          updatedCards.add(card);
          continue;
        }

        if (translated.length != texts.length) {
          updatedCards.add(card);
          continue;
        }

        final translatedQuestion = translated.first;
        final translatedAnswers = translated.sublist(1);

        final correctIndex = card.answers.indexOf(card.correctAnswer);
        final translation = CardText(
          question: translatedQuestion,
          answers: translatedAnswers,
          correctIndex: correctIndex >= 0 ? correctIndex : 0,
          version: 1,
        );

        final merged = <String, CardText>{};
        if (existing != null) merged.addAll(existing);
        merged[lang] = translation;

        updatedCards.add(
          CardModel(
            id: card.id,
            question: card.question,
            answers: card.answers,
            correctAnswer: card.correctAnswer,
            sourceLanguage: card.sourceLanguage,
            category: card.category,
            difficulty: card.difficulty,
            createdAt: card.createdAt,
            source: card.source,
            translations: merged,
          ),
        );

        changed = true;
        addedTranslationsCount++;
      }

      if (!changed) return;

      // Persist once (batch) for all updated cards.
      await widget.repository.save(updatedCards);

      // Debug-only: verify that persisted translations for this language can be read back.
      if (kDebugMode && !_didLogTranslationPersistForLang.contains(lang)) {
        _didLogTranslationPersistForLang.add(lang);
        try {
          final reloaded = await widget.repository.load();
          final savedIds = <String>{for (final c in updatedCards) c.id};
          var verified = 0;
          for (final c in reloaded) {
            if (!savedIds.contains(c.id)) continue;
            final tr = c.translations;
            if (tr != null && tr[lang] != null) {
              verified++;
            }
          }
          debugPrint(
            'TRANSLATION_PERSIST_CHECK: lang=$lang '
            'saved=${updatedCards.length} verified=$verified',
          );
        } catch (_) {
          // Never crash on debug checks.
        }
      }

      if (!mounted) return;
      // Update UI with resolved cards (now that translations exist).
      final resolved = updatedCards
          .map((c) => widget.repository.resolveForLocale(c, lang))
          .toList(growable: false);
      setState(() {
        _cards = resolved;
      });

      if (!_didLogAddedTranslationsCount) {
        _didLogAddedTranslationsCount = true;
        debugPrint(
          'ADDED TRANSLATIONS: addedTranslationsCount=$addedTranslationsCount',
        );
      }
    } catch (_) {
      // Hard failsafe: never crash.
    } finally {
      _persistingTranslations = false;
    }
  }

  Future<void> _runImport() async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);

    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text(l10n.import_running)));

    try {
      final imported = await _importer.fetch(amount: 25);
      final result = await widget.repository.mergeAndPersist(imported);

      if (!mounted) return;
      setState(() {
        _cards = result.cards;
      });

      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.import_done(result.newCount))),
      );
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _openLanguageSheet() async {
    final l10n = AppLocalizations.of(context)!;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) {
        final current = widget.localeController.currentCode;
        final options = const <_LocaleOption>[
          _LocaleOption(code: 'system', title: 'System'),
          _LocaleOption(code: 'en', title: 'English'),
          _LocaleOption(code: 'de', title: 'Deutsch'),
          _LocaleOption(code: 'es', title: 'Español'),
        ];

        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.menu_language,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 360),
                  child: RadioGroup<String>(
                    groupValue: current,
                    onChanged: (v) async {
                      if (v == null) return;
                      await widget.localeController.setLocaleCode(v);
                      if (context.mounted) Navigator.of(context).pop();
                    },
                    child: ListView(
                      shrinkWrap: true,
                      children: [
                        for (final opt in options)
                          RadioListTile<String>(
                            value: opt.code,
                            title: Text(opt.title),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _openReportSheet(CardModel card) async {
    final l10n = AppLocalizations.of(context)!;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l10n.report_title,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 360),
                  child: ListView(
                    shrinkWrap: true,
                    children: [
                      ListTile(
                        leading: const Icon(
                          Icons.local_fire_department_outlined,
                        ),
                        title: Text(l10n.report_too_hard),
                        onTap: () => Navigator.of(context).pop(),
                      ),
                      ListTile(
                        leading: const Icon(Icons.sentiment_satisfied_outlined),
                        title: Text(l10n.report_too_easy),
                        onTap: () => Navigator.of(context).pop(),
                      ),
                      ListTile(
                        leading: const Icon(Icons.flag_outlined),
                        title: Text(l10n.report_wrong_unclear),
                        onTap: () => Navigator.of(context).pop(),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final isFlow = _section == DrawerSection.flow;

    return Scaffold(
      key: _scaffoldKey,
      appBar: isFlow
          ? null
          : AppBar(title: Text(_sectionTitle(l10n, _section))),
      drawer: Drawer(
        child: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: ListView(
                  padding: EdgeInsets.zero,
                  children: [
                    const _DrawerHeader(),
                    _drawerItem(
                      title: 'FLOW',
                      icon: Icons.water_drop_outlined,
                      selected: _section == DrawerSection.flow,
                      onTap: () => _selectSection(DrawerSection.flow),
                    ),
                    _drawerItem(
                      title: 'SPRINT',
                      icon: Icons.bolt_outlined,
                      selected: _section == DrawerSection.sprint,
                      onTap: () => _selectSection(DrawerSection.sprint),
                    ),
                    _drawerItem(
                      title: 'RUN',
                      icon: Icons.directions_run_outlined,
                      selected: _section == DrawerSection.run,
                      onTap: () => _selectSection(DrawerSection.run),
                    ),
                    _drawerItem(
                      title: 'PROGRESS',
                      icon: Icons.show_chart_outlined,
                      selected: _section == DrawerSection.progress,
                      onTap: () => _selectSection(DrawerSection.progress),
                    ),
                    const Divider(),
                  ],
                ),
              ),
              Builder(
                builder: (drawerContext) => _DrawerBottomButtons(
                  onAccountTap: () {
                    Navigator.of(drawerContext).pop(); // close drawer
                    showModalBottomSheet<void>(
                      context: context,
                      isScrollControlled: true,
                      showDragHandle: true,
                      useRootNavigator: true,
                      builder: (ctx) => _AccountScreen(),
                    );
                  },
                  onSettingsTap: () {
                    Navigator.of(drawerContext).pop(); // close drawer
                    showModalBottomSheet<void>(
                      context: context,
                      isScrollControlled: true,
                      showDragHandle: true,
                      useRootNavigator: true,
                      builder: (ctx) => _SettingsScreen(
                        hapticsEnabled: _hapticsEnabled,
                        soundEnabled: _soundEnabled,
                        onHapticsChanged: (value) =>
                            setState(() => _hapticsEnabled = value),
                        onSoundChanged: (value) =>
                            setState(() => _soundEnabled = value),
                        onLanguageTap: () async {
                          await _openLanguageSheet();
                        },
                        onReloadCards: () async {
                          await _loadCards();
                        },
                        onImportCards: () async {
                          await _runImport();
                        },
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
      body: isFlow
          ? SafeArea(
              child: ColoredBox(
                color: Colors.black,
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: _loading
                          ? const Center(child: CircularProgressIndicator())
                          : _cards.isEmpty
                          ? Center(
                              child: Padding(
                                padding: const EdgeInsets.all(24),
                                child: Text(
                                  l10n.no_cards_loaded,
                                  textAlign: TextAlign.center,
                                  style: Theme.of(
                                    context,
                                  ).textTheme.titleMedium,
                                ),
                              ),
                            )
                          : _FlowView(
                              cards: _cards,
                              onReport: _openReportSheet,
                              hapticsEnabled: _hapticsEnabled,
                            ),
                    ),
                    Positioned(
                      top: 0,
                      left: 0,
                      right: 0,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 8,
                        ),
                        child: Row(
                          children: [
                            Builder(
                              builder: (context) {
                                return IconButton(
                                  onPressed: () =>
                                      _scaffoldKey.currentState?.openDrawer(),
                                  icon: const Icon(Icons.menu_rounded),
                                  style: IconButton.styleFrom(
                                    backgroundColor: Colors.black.withValues(
                                      alpha: 0.35,
                                    ),
                                    foregroundColor: Colors.white,
                                    shape: const CircleBorder(),
                                    padding: const EdgeInsets.all(10),
                                  ),
                                );
                              },
                            ),
                            const Spacer(),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            )
          : _loading
          ? const Center(child: CircularProgressIndicator())
          : _cards.isEmpty
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  l10n.no_cards_loaded,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
            )
          : _section == DrawerSection.progress
          ? _ProgressSection(
              difficulty: _difficulty,
              onDifficultyChanged: (value) =>
                  setState(() => _difficulty = value),
            )
          : _PlaceholderSection(title: _sectionTitle(l10n, _section)),
    );
  }

  void _selectSection(DrawerSection section) {
    Navigator.of(context).pop(); // close drawer
    setState(() => _section = section);
  }

  Widget _drawerItem({
    required String title,
    required IconData icon,
    required bool selected,
    required VoidCallback onTap,
  }) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title),
      selected: selected,
      onTap: onTap,
    );
  }
}

String _sectionTitle(AppLocalizations l10n, DrawerSection section) {
  switch (section) {
    case DrawerSection.flow:
      return 'FLOW';
    case DrawerSection.sprint:
      return 'SPRINT';
    case DrawerSection.run:
      return 'RUN';
    case DrawerSection.progress:
      return 'PROGRESS';
  }
}

class _DrawerBottomButtons extends StatelessWidget {
  const _DrawerBottomButtons({
    required this.onAccountTap,
    required this.onSettingsTap,
  });

  final VoidCallback onAccountTap;
  final VoidCallback onSettingsTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
        borderRadius: const BorderRadius.only(
          topLeft: Radius.circular(16),
          topRight: Radius.circular(16),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            Expanded(
              child: _BottomButton(
                icon: Icons.person_outline,
                label: l10n.menu_account,
                onTap: onAccountTap,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _BottomButton(
                icon: Icons.settings_outlined,
                label: l10n.menu_settings,
                onTap: onSettingsTap,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BottomButton extends StatelessWidget {
  const _BottomButton({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Material(
      color: cs.surface.withValues(alpha: 0.6),
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 32, color: cs.onSurface),
              const SizedBox(height: 8),
              Text(
                label,
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                  color: cs.onSurface,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 16, bottom: 8, left: 16),
      child: Text(
        title,
        style: theme.textTheme.labelLarge?.copyWith(
          fontWeight: FontWeight.w600,
          color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.7),
        ),
      ),
    );
  }
}

class _DifficultySelector extends StatelessWidget {
  const _DifficultySelector({required this.current, required this.onSelected});

  final String current;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final options = ['easy', 'medium', 'hard'];

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Schwierigkeit', style: theme.textTheme.titleLarge),
            const SizedBox(height: 16),
            RadioGroup<String>(
              groupValue: current,
              onChanged: (value) {
                if (value != null) onSelected(value);
              },
              child: Column(
                children: options
                    .map(
                      (option) => RadioListTile<String>(
                        title: Text(option),
                        value: option,
                      ),
                    )
                    .toList(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DrawerHeader extends StatelessWidget {
  const _DrawerHeader();

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            cs.primary.withValues(alpha: 0.35),
            cs.primaryContainer.withValues(alpha: 0.15),
          ],
        ),
      ),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: cs.primary.withValues(alpha: 0.35),
            child: const Icon(Icons.auto_awesome),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Brainflow',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 2),
                Text('MVP', style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// (old list-style card widget removed; FLOW uses _FlowView now)

class _LocaleOption {
  const _LocaleOption({required this.code, required this.title});
  final String code;
  final String title;
}

class _PlaceholderSection extends StatelessWidget {
  const _PlaceholderSection({required this.title});
  final String title;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          title,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleLarge,
        ),
      ),
    );
  }
}

class _ProgressSection extends StatelessWidget {
  const _ProgressSection({
    required this.difficulty,
    required this.onDifficultyChanged,
  });

  final String difficulty;
  final ValueChanged<String> onDifficultyChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context)!;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l10n.progress_training_title,
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 24),
            ListTile(
              leading: const Icon(Icons.trending_up_outlined),
              title: Text(l10n.progress_difficulty),
              subtitle: Text(difficulty),
              trailing: const Icon(Icons.chevron_right),
              onTap: () {
                showModalBottomSheet<void>(
                  context: context,
                  builder: (context) => _DifficultySelector(
                    current: difficulty,
                    onSelected: (value) {
                      Navigator.of(context).pop();
                      onDifficultyChanged(value);
                    },
                  ),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.category_outlined),
              title: Text(l10n.progress_select_categories),
              trailing: const Icon(Icons.chevron_right),
              onTap: () {
                ScaffoldMessenger.of(
                  context,
                ).showSnackBar(const SnackBar(content: Text('TODO')));
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _AccountScreen extends StatelessWidget {
  const _AccountScreen();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;

    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.9,
      ),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              margin: const EdgeInsets.only(top: 12),
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: cs.onSurfaceVariant.withValues(alpha: 0.4),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
              child: Row(
                children: [
                  Text(
                    l10n.account_title,
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.symmetric(horizontal: 20),
                children: [
                  _SectionHeader(title: l10n.account_section_profile),
                  ListTile(
                    leading: const Icon(Icons.edit_outlined),
                    title: Text(l10n.account_edit_profile),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () {
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(const SnackBar(content: Text('TODO')));
                    },
                  ),
                  ListTile(
                    leading: const Icon(Icons.login_outlined),
                    title: Text(l10n.account_sign_in),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () {
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(const SnackBar(content: Text('TODO')));
                    },
                  ),
                  const Divider(height: 32),
                  _SectionHeader(title: l10n.account_section_subscription),
                  ListTile(
                    leading: const Icon(Icons.card_membership_outlined),
                    title: Text(l10n.account_manage_subscription),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () {
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(const SnackBar(content: Text('TODO')));
                    },
                  ),
                  ListTile(
                    leading: const Icon(Icons.restore_outlined),
                    title: Text(l10n.account_restore_purchases),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () {
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(const SnackBar(content: Text('TODO')));
                    },
                  ),
                  const Divider(height: 32),
                  _SectionHeader(title: l10n.settings_section_info),
                  ListTile(
                    leading: const Icon(Icons.info_outline),
                    title: Text(l10n.settings_about),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () {
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(const SnackBar(content: Text('TODO')));
                    },
                  ),
                  const SizedBox(height: 20),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SettingsScreen extends StatelessWidget {
  const _SettingsScreen({
    required this.hapticsEnabled,
    required this.soundEnabled,
    required this.onHapticsChanged,
    required this.onSoundChanged,
    required this.onLanguageTap,
    required this.onReloadCards,
    required this.onImportCards,
  });

  final bool hapticsEnabled;
  final bool soundEnabled;
  final ValueChanged<bool> onHapticsChanged;
  final ValueChanged<bool> onSoundChanged;
  final Future<void> Function() onLanguageTap;
  final Future<void> Function() onReloadCards;
  final Future<void> Function() onImportCards;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;

    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.9,
      ),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              margin: const EdgeInsets.only(top: 12),
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: cs.onSurfaceVariant.withValues(alpha: 0.4),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
              child: Row(
                children: [
                  Text(
                    l10n.menu_settings,
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.symmetric(horizontal: 20),
                children: [
                  _SectionHeader(title: l10n.settings_section_general),
                  ListTile(
                    leading: const Icon(Icons.language_outlined),
                    title: Text(l10n.menu_language),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () async {
                      await onLanguageTap();
                    },
                  ),
                  SwitchListTile(
                    secondary: const Icon(Icons.vibration_outlined),
                    title: Text(l10n.settings_haptics),
                    value: hapticsEnabled,
                    onChanged: onHapticsChanged,
                  ),
                  SwitchListTile(
                    secondary: const Icon(Icons.volume_up_outlined),
                    title: Text(l10n.settings_sound),
                    value: soundEnabled,
                    onChanged: onSoundChanged,
                  ),
                  const Divider(height: 32),
                  _SectionHeader(title: l10n.settings_section_data),
                  ListTile(
                    leading: const Icon(Icons.refresh_outlined),
                    title: Text(l10n.settings_reload_cards),
                    onTap: () async {
                      await onReloadCards();
                    },
                  ),
                  ListTile(
                    leading: const Icon(Icons.cloud_download_outlined),
                    title: Text(l10n.settings_import_25),
                    onTap: () async {
                      await onImportCards();
                    },
                  ),
                  ListTile(
                    leading: const Icon(
                      Icons.delete_outline,
                      color: Colors.red,
                    ),
                    title: Text(
                      l10n.settings_reset_local,
                      style: const TextStyle(color: Colors.red),
                    ),
                    onTap: () {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('TODO: Confirm Dialog')),
                      );
                    },
                  ),
                  const Divider(height: 32),
                  _SectionHeader(title: l10n.settings_section_legal),
                  ListTile(
                    leading: const Icon(Icons.privacy_tip_outlined),
                    title: Text(l10n.settings_privacy),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () {
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(const SnackBar(content: Text('TODO')));
                    },
                  ),
                  ListTile(
                    leading: const Icon(Icons.description_outlined),
                    title: Text(l10n.settings_imprint),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () {
                      ScaffoldMessenger.of(
                        context,
                      ).showSnackBar(const SnackBar(content: Text('TODO')));
                    },
                  ),
                  const SizedBox(height: 20),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _FlowView extends StatefulWidget {
  const _FlowView({
    required this.cards,
    required this.onReport,
    required this.hapticsEnabled,
  });

  final List<CardModel> cards;
  final Future<void> Function(CardModel card) onReport;
  final bool hapticsEnabled;

  @override
  State<_FlowView> createState() => _FlowViewState();
}

class _FlowViewState extends State<_FlowView> with TickerProviderStateMixin {
  late final PageController _controller;
  late final AnimationController _cardScaleController;
  late final Animation<double> _cardScaleAnimation;
  late final AnimationController _shakeController;
  late final Animation<double> _shakeRotationAnimation;
  late final Animation<Offset> _shakeTranslationAnimation;
  Timer? _feedbackTimer;
  int _currentIndex = 0;
  String? _previousCardId; // Track card ID for animation trigger
  bool _answerLocked = false;
  _FlowFeedback _feedback = _FlowFeedback.none;
  // Answer feedback state (for current card)
  String? _selectedAnswer; // null = not answered yet
  bool _isAnswered = false; // Whether an answer was selected
  bool _isCorrectlyAnswered = false; // Whether the selected answer was correct
  double _dragDx = 0.0;
  double _dragDy = 0.0;
  bool _swipeConsumed = false;

  @override
  void initState() {
    super.initState();
    _controller = PageController();
    // Card scale-in animation (0.98 → 1.00)
    _cardScaleController = AnimationController(
      duration: const Duration(milliseconds: 200), // Within 160-220ms range
      vsync: this,
    );
    _cardScaleAnimation = Tween<double>(begin: 0.98, end: 1.0).animate(
      CurvedAnimation(parent: _cardScaleController, curve: Curves.easeOutCubic),
    );
    // Start initial animation
    _cardScaleController.forward();

    // Shake animation for Like/Dislike feedback
    _shakeController = AnimationController(
      duration: const Duration(milliseconds: 180), // 120-220ms range
      vsync: this,
    );
    // Shake rotation: -3° to +3° (subtle)
    _shakeRotationAnimation = TweenSequence<double>(
      [
        TweenSequenceItem(
          tween: Tween<double>(begin: 0.0, end: -0.05),
          weight: 1,
        ), // ~-3°
        TweenSequenceItem(
          tween: Tween<double>(begin: -0.05, end: 0.05),
          weight: 1,
        ), // +3°
        TweenSequenceItem(
          tween: Tween<double>(begin: 0.05, end: -0.03),
          weight: 1,
        ), // -2°
        TweenSequenceItem(
          tween: Tween<double>(begin: -0.03, end: 0.0),
          weight: 1,
        ), // back to 0
      ],
    ).animate(CurvedAnimation(parent: _shakeController, curve: Curves.easeOut));
    // Shake translation: small horizontal movement
    _shakeTranslationAnimation = TweenSequence<Offset>(
      [
        TweenSequenceItem(
          tween: Tween<Offset>(begin: Offset.zero, end: const Offset(-4, 0)),
          weight: 1,
        ),
        TweenSequenceItem(
          tween: Tween<Offset>(
            begin: const Offset(-4, 0),
            end: const Offset(4, 0),
          ),
          weight: 1,
        ),
        TweenSequenceItem(
          tween: Tween<Offset>(
            begin: const Offset(4, 0),
            end: const Offset(-2, 0),
          ),
          weight: 1,
        ),
        TweenSequenceItem(
          tween: Tween<Offset>(begin: const Offset(-2, 0), end: Offset.zero),
          weight: 1,
        ),
      ],
    ).animate(CurvedAnimation(parent: _shakeController, curve: Curves.easeOut));
  }

  @override
  void dispose() {
    _feedbackTimer?.cancel();
    _cardScaleController.dispose();
    _shakeController.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _showFeedback(_FlowFeedback feedback, {int millis = 260}) {
    _feedbackTimer?.cancel();
    setState(() {
      _feedback = feedback;
    });

    // Trigger shake animation for Like/Dislike
    if (feedback == _FlowFeedback.like || feedback == _FlowFeedback.dislike) {
      _shakeController.reset();
      _shakeController.forward();

      // Haptic feedback (only if enabled)
      if (widget.hapticsEnabled) {
        if (feedback == _FlowFeedback.like) {
          HapticFeedback.lightImpact();
        } else if (feedback == _FlowFeedback.dislike) {
          HapticFeedback.mediumImpact();
        }
      }
    }

    _feedbackTimer = Timer(Duration(milliseconds: millis), () {
      if (!mounted) return;
      setState(() => _feedback = _FlowFeedback.none);
    });
  }

  Future<void> _goNext({int millis = 420}) async {
    if (!_controller.hasClients) return;
    if (widget.cards.isEmpty) return;

    // Endless flow: always go to next page (PageView handles wrap-around via itemCount)
    await _controller.nextPage(
      duration: Duration(milliseconds: millis),
      curve: Curves.easeInOutCubic,
    );
  }

  Future<void> _goPrev({int millis = 260}) async {
    if (!_controller.hasClients) return;
    final current = (_controller.page ?? _controller.initialPage.toDouble())
        .round()
        .clamp(0, widget.cards.length - 1);
    if (current <= 0) return;

    await _controller.previousPage(
      duration: Duration(milliseconds: millis),
      curve: Curves.easeOutCubic,
    );
  }

  Future<void> _handleAnswer(
    CardModel card,
    String answer,
    BuildContext? buttonContext,
    GlobalKey? cardStackKey,
  ) async {
    if (_answerLocked) return;
    _answerLocked = true;

    final isCorrect = answer == card.correctAnswer;
    if (!mounted) {
      _answerLocked = false;
      return;
    }

    // Update answer feedback state (ALWAYS set, even if comparison fails)
    setState(() {
      _selectedAnswer = answer;
      _isAnswered = true;
      _isCorrectlyAnswered = isCorrect;
    });

    if (isCorrect) {
      // Optional light haptic for correct answer (respect settings)
      if (widget.hapticsEnabled) {
        HapticFeedback.lightImpact();
      }
      // Small pause before moving to next card
      await Future<void>.delayed(const Duration(milliseconds: 800));
      if (!mounted) return;
      // Smooth page transition with longer duration
      await _goNext(millis: 420);
    } else {
      // Shorter feedback, but ensure it doesn't change during transition
      _showFeedback(_FlowFeedback.wrong, millis: 200);
      if (widget.hapticsEnabled) {
        HapticFeedback.mediumImpact();
      }
      await Future<void>.delayed(const Duration(milliseconds: 200));
      if (!mounted) return;
      // Small delay before transition for smooth feel
      await Future<void>.delayed(const Duration(milliseconds: 80));
      if (!mounted) return;
      // Same smooth transition parameters as correct answer
      await _goNext(millis: 420);
    }

    if (!mounted) return;
    _answerLocked = false;
  }

  @override
  Widget build(BuildContext context) {
    if (widget.cards.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    // Use very large itemCount for endless flow
    const maxItemCount = 10000;
    final itemCount = math.min(widget.cards.length * 100, maxItemCount);

    return PageView.builder(
      controller: _controller,
      scrollDirection: Axis.vertical,
      itemCount: itemCount,
      onPageChanged: (i) {
        // Handle endless flow: wrap around using modulo
        final actualIndex = i % widget.cards.length;
        final currentCard = widget.cards[actualIndex];
        final currentCardId = currentCard.id;

        // Trigger scale-in animation if card ID changed
        if (currentCardId != _previousCardId) {
          _cardScaleController.reset();
          _cardScaleController.forward();
        }

        setState(() {
          _currentIndex = actualIndex;
          _previousCardId = currentCardId;
          _answerLocked = false;
          _feedback = _FlowFeedback.none;
          _swipeConsumed = false;
          // Reset answer feedback state for new card
          _selectedAnswer = null;
          _isAnswered = false;
          _isCorrectlyAnswered = false;
        });

        // Check if we need to download more cards (placeholder)
        if (widget.cards.isNotEmpty) {
          final remaining = widget.cards.length - actualIndex;
          final total = widget.cards.length;
          if (remaining / total < 0.30) {
            // Would trigger server download in the future
          }
        }
      },
      itemBuilder: (context, index) {
        // Wrap around to actual card index
        final cardIndex = index % widget.cards.length;
        final card = widget.cards[cardIndex];
        final style = _categoryStyle(card.category);
        final isActive = cardIndex == _currentIndex;
        final showWrongFlash = isActive && _feedback == _FlowFeedback.wrong;

        // Create a local key for this card's stack
        final cardStackKey = GlobalKey();

        return GestureDetector
          (
          onPanStart: (_) {
            _dragDx = 0;
            _dragDy = 0;
            _swipeConsumed = false;
          },
          onPanUpdate: (details) {
            _dragDx += details.delta.dx;
            _dragDy += details.delta.dy;
          },
          onPanEnd: (_) {
            if (_answerLocked) return;
            if (_swipeConsumed) return;

            final absDx = _dragDx.abs();
            final absDy = _dragDy.abs();

            // Nur reagieren, wenn horizontal dominanter als vertikal
            if (absDx > absDy) {
              _swipeConsumed = true;
              if (_dragDx > 0) {
                // Swipe nach rechts → Like
                _showFeedback(
                  _FlowFeedback.like,
                  millis: 600,
                ); // 500-700ms range
                return;
              } else {
                // Swipe nach links → Dislike
                _showFeedback(
                  _FlowFeedback.dislike,
                  millis: 600,
                ); // 500-700ms range
                return;
              }
            }
          },
          child: Stack(
            key: cardStackKey,
            children: [
              // Shake + Scale animation wrapper (only for active card)
              AnimatedBuilder(
                animation: _shakeController,
                builder: (context, child) {
                  final offset =
                      isActive ? _shakeTranslationAnimation.value : Offset.zero;
                  final angle =
                      isActive ? _shakeRotationAnimation.value : 0.0;
                  return Transform.translate(
                    offset: offset,
                    child: Transform.rotate(
                      angle: angle,
                      child: child,
                    ),
                  );
                },
                child: ScaleTransition(
                  scale: isActive
                      ? _cardScaleAnimation
                      : const AlwaysStoppedAnimation(1.0),
                  child: Card(
                    margin: EdgeInsets.zero,
                    elevation: 0,
                    color: Theme.of(context)
                        .colorScheme
                        .surfaceContainerHighest
                        .withValues(alpha: 0.72),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                      side: BorderSide(
                        color: style.color.withValues(alpha: 0.70),
                        width: 1.2,
                      ),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _FlowTopRow(
                            card: card,
                            onReport: () => widget.onReport(card),
                          ),
                          const SizedBox(height: 12),
                          Expanded(
                            child: _FlowCard(
                              card: card,
                              style: style,
                              locked: _answerLocked && isActive,
                              onAnswer: (a, context) => _handleAnswer(
                                card,
                                a,
                                context,
                                cardStackKey,
                              ),
                              // Answer feedback state (only for active card)
                              isAnswered: isActive ? _isAnswered : false,
                              selectedAnswer:
                                  isActive ? _selectedAnswer : null,
                              isCorrectlyAnswered:
                                  isActive ? _isCorrectlyAnswered : false,
                            ),
                          ),
                          const SizedBox(height: 8),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              if (isActive && _feedback == _FlowFeedback.like)
                ClipRRect(
                  borderRadius: BorderRadius.circular(16),
                  child: Container(
                    width: double.infinity,
                    height: double.infinity,
                    color: Colors.green.withValues(alpha: 0.32),
                    child: const Center(
                      child: Icon(
                        Icons.thumb_up_alt_rounded,
                        size: 48,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              if (isActive && _feedback == _FlowFeedback.dislike)
                ClipRRect(
                  borderRadius: BorderRadius.circular(16),
                  child: Container(
                    width: double.infinity,
                    height: double.infinity,
                    color: Colors.red.withValues(alpha: 0.32),
                    child: const Center(
                      child: Icon(
                        Icons.thumb_down_alt_rounded,
                        size: 48,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildFeedbackWidget({
    required bool isActive,
    required int seed,
    required Color accent,
  }) {
    if (!isActive) return const SizedBox.shrink();

    switch (_feedback) {
      case _FlowFeedback.none:
        return const SizedBox.shrink();
      case _FlowFeedback.like:
        return const Icon(
          Icons.thumb_up_alt_rounded,
          key: ValueKey('like'),
          size: 32,
        );
      case _FlowFeedback.dislike:
        return const Icon(
          Icons.thumb_down_alt_rounded,
          key: ValueKey('dislike'),
          size: 32,
        );
      case _FlowFeedback.wrong:
      case _FlowFeedback.correct:
        return const SizedBox.shrink();
    }
  }
}

class _FlowTopRow extends StatelessWidget {
  const _FlowTopRow({required this.card, required this.onReport});

  final CardModel card;
  final VoidCallback onReport;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 36),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            const Spacer(),
            IconButton(
              tooltip: AppLocalizations.of(context)!.report_title,
              onPressed: onReport,
              icon: const Icon(Icons.flag_outlined),
              visualDensity: VisualDensity.compact,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            ),
          ],
        ),
      ),
    );
  }
}

class _FlowCard extends StatelessWidget {
  const _FlowCard({
    required this.card,
    required this.style,
    required this.onAnswer,
    required this.locked,
    required this.isAnswered,
    required this.selectedAnswer,
    required this.isCorrectlyAnswered,
  });
  final CardModel card;
  final _CategoryStyle style;
  final void Function(String, BuildContext?) onAnswer;
  final bool locked;
  final bool isAnswered;
  final String? selectedAnswer;
  final bool isCorrectlyAnswered;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    // meta variable removed

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 4),
        Center(
          child: SizedBox(
            height: 58,
            width: 58,
            child: SvgPicture.asset(
              style.assetPath,
              colorFilter: ColorFilter.mode(style.color, BlendMode.srcIn),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Flexible(
          // Slightly smaller question area; keep it readable but limit height
          flex: 4,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 150),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: cs.surface.withValues(alpha: 0.45),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: style.color.withValues(alpha: 0.18),
                  width: 1,
                ),
              ),
              child: Center(
                child: _AutoFitText(
                  text: card.question,
                  textAlign: TextAlign.center,
                  // Limit max lines / font size so the question doesn't dominate
                  maxLines: 5,
                  minFontSize: 10.0,
                  maxFontSize: 20.0,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
          ),
        ),
        // meta section removed
        const SizedBox(height: 8),
        Expanded(
          // Give answers a bit more vertical space for better tap targets
          flex: 6,
          child: _AnswerGrid(
            answers: card.answers.take(4).toList(growable: false),
            correctIndex: () {
              final visibleAnswers =
                  card.answers.take(4).toList(growable: false);
              final idx = visibleAnswers.indexOf(card.correctAnswer);
              return idx >= 0 ? idx : 0;
            }(),
            locked: locked,
            onAnswer: onAnswer,
            isAnswered: isAnswered,
            selectedAnswer: selectedAnswer,
            isCorrectlyAnswered: isCorrectlyAnswered,
          ),
        ),
      ],
    );
  }
}

class _AutoFitText extends StatelessWidget {
  const _AutoFitText({
    required this.text,
    required this.style,
    this.textAlign,
    this.maxLines = 4,
    this.minFontSize = 14,
    this.maxFontSize = 34,
  });

  final String text;
  final TextStyle? style;
  final TextAlign? textAlign;
  final int maxLines;
  final double minFontSize;
  final double maxFontSize;

  bool _fits(BoxConstraints c, double fontSize) {
    final s = (style ?? const TextStyle()).copyWith(fontSize: fontSize);
    final tp = TextPainter(
      text: TextSpan(text: text, style: s),
      textAlign: textAlign ?? TextAlign.center,
      textDirection: TextDirection.ltr,
      maxLines: maxLines,
    )..layout(maxWidth: c.maxWidth);
    return tp.didExceedMaxLines == false && tp.height <= c.maxHeight;
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        // Binary search for optimal font size (more efficient, less flicker)
        double low = minFontSize;
        double high = maxFontSize;
        double fontSize = maxFontSize;

        // Quick check: if max size fits, use it
        if (_fits(constraints, maxFontSize)) {
          fontSize = maxFontSize;
        } else {
          // Binary search for best fit
          while (high - low > 0.5) {
            final mid = (low + high) / 2;
            if (_fits(constraints, mid)) {
              low = mid;
              fontSize = mid;
            } else {
              high = mid;
            }
          }
          fontSize = low;
        }

        return Text(
          text,
          textAlign: textAlign,
          maxLines: maxLines,
          overflow: TextOverflow.ellipsis,
          style: (style ?? const TextStyle()).copyWith(fontSize: fontSize),
        );
      },
    );
  }
}

enum _FlowFeedback { none, like, dislike, correct, wrong }

class _CategoryStyle {
  const _CategoryStyle({required this.assetPath, required this.color});
  final String assetPath;
  final Color color;
}

_CategoryStyle _categoryStyle(String? rawCategory) {
  final c = (rawCategory ?? '').trim();
  final lower = c.toLowerCase();

  if (lower.contains('science')) {
    return const _CategoryStyle(
      assetPath: 'assets/icons/categories/science.svg',
      color: Color(0xFF22D3EE),
    );
  }
  if (lower.contains('entertainment')) {
    return const _CategoryStyle(
      assetPath: 'assets/icons/categories/entertainment.svg',
      color: Color(0xFFA855F7),
    );
  }
  if (lower.contains('history')) {
    return const _CategoryStyle(
      assetPath: 'assets/icons/categories/history.svg',
      color: Color(0xFFF59E0B),
    );
  }
  if (lower.contains('geography')) {
    return const _CategoryStyle(
      assetPath: 'assets/icons/categories/geography.svg',
      color: Color(0xFF60A5FA),
    );
  }
  if (lower.contains('sport')) {
    return const _CategoryStyle(
      assetPath: 'assets/icons/categories/sports.svg',
      color: Color(0xFF22C55E),
    );
  }
  if (lower.contains('art')) {
    return const _CategoryStyle(
      assetPath: 'assets/icons/categories/art.svg',
      color: Color(0xFFF472B6),
    );
  }

  return const _CategoryStyle(
    assetPath: 'assets/icons/categories/general.svg',
    color: Colors.grey,
  );
}

class _AnswerGrid extends StatelessWidget {
  const _AnswerGrid({
    required this.answers,
    required this.correctIndex,
    required this.locked,
    required this.onAnswer,
    required this.isAnswered,
    required this.selectedAnswer,
    required this.isCorrectlyAnswered,
  });

  final List<String> answers;
  final int correctIndex;
  final bool locked;
  final void Function(String, BuildContext?) onAnswer;
  final bool isAnswered;
  final String? selectedAnswer;
  final bool isCorrectlyAnswered;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    // Neutral base border for all answers; explicit green accent for the correct one
    final Color neutralBorder = cs.outlineVariant.withValues(alpha: 0.6);
    // Explicit green for correct-answer highlight (avoid theme pinks)
    final Color accentBorder = const Color(0xFF22C55E);

    final normalized = answers.length >= 4
        ? answers.take(4).toList(growable: false)
        : <String>[...answers, for (var i = answers.length; i < 4; i++) ''];

    Widget button(int idx, BuildContext gridContext) {
      final label = normalized[idx];
      final isCorrect = idx == correctIndex;
      final isSelected = selectedAnswer != null && label == selectedAnswer;

      // Determine visual state based on answer rules
      bool shouldHighlight = false;
      bool shouldDim = false;

      if (isAnswered) {
        if (isCorrectlyAnswered) {
          // STATE_CORRECT: highlight only the correct answer (no blur), dim all others
          shouldHighlight = isCorrect;
          shouldDim = !isCorrect;
        } else {
          // STATE_WRONG: dim/blur all answers, no highlight to hide the correct one
          shouldDim = true;
        }
      }

      final Color borderColor =
          shouldHighlight ? accentBorder : neutralBorder;

      return Builder(
        builder: (buttonContext) => _AnswerButton(
          label: label,
          borderColor: borderColor,
          enabled: !locked && label.isNotEmpty,
          onTap: () => onAnswer(label, buttonContext),
          shouldHighlight: shouldHighlight,
          shouldDim: shouldDim,
        ),
      );
    }

    return Builder(
      builder: (gridContext) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(child: button(0, gridContext)),
          const SizedBox(height: 6),
          Expanded(child: button(1, gridContext)),
          const SizedBox(height: 6),
          Expanded(child: button(2, gridContext)),
          const SizedBox(height: 6),
          Expanded(child: button(3, gridContext)),
        ],
      ),
    );
  }
}

class _AnswerButton extends StatefulWidget {
  const _AnswerButton({
    required this.label,
    required this.borderColor,
    required this.enabled,
    required this.onTap,
    this.shouldHighlight = false,
    this.shouldDim = false,
  });

  final String label;
  final Color borderColor;
  final bool enabled;
  final VoidCallback onTap;
  final bool shouldHighlight;
  final bool shouldDim;

  @override
  State<_AnswerButton> createState() => _AnswerButtonState();
}

class _AnswerButtonState extends State<_AnswerButton> {
  var _pressed = false;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;

    return AnimatedScale(
      scale: _pressed ? 0.985 : 1,
      duration: const Duration(milliseconds: 90),
      curve: Curves.easeOut,
      child: AnimatedPhysicalModel(
        duration: const Duration(milliseconds: 90),
        curve: Curves.easeOut,
        shape: BoxShape.rectangle,
        shadowColor: Colors.black,
        elevation: _pressed ? 1 : 4,
        color: cs.surface,
        borderRadius: BorderRadius.circular(14),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: widget.enabled
                ? widget.onTap
                : null, // Lock handled by 'locked' prop
            onTapDown: widget.enabled
                ? (_) => setState(() => _pressed = true)
                : null,
            onTapCancel: widget.enabled
                ? () => setState(() => _pressed = false)
                : null,
            onTapUp: widget.enabled
                ? (_) => setState(() => _pressed = false)
                : null,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: widget.shouldDim
                  ? BackdropFilter(
                      // Strong blur for non-relevant answers
                      filter: ImageFilter.blur(sigmaX: 4.0, sigmaY: 4.0),
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 450),
                        curve: Curves.easeOutCubic,
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          // slightly reduce height (~10% kleiner als vorher)
                          vertical: 9,
                        ),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(
                            color: widget.borderColor.withValues(
                              // keep border subtle even if highlight flag is set
                              alpha: widget.shouldHighlight ? 0.5 : 0.25,
                            ),
                            width: 1.6,
                          ),
                          color: Colors.black.withValues(
                            alpha: 0.22,
                          ),
                        ),
                        child: Center(
                          child: Text(
                            widget.label,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            textAlign: TextAlign.center,
                            style: Theme.of(context)
                                .textTheme
                                .bodyMedium
                                ?.copyWith(
                                  fontSize: 16.8,
                                  fontWeight: FontWeight.w700,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurface
                                      .withValues(alpha: 0.30),
                                ),
                          ),
                        ),
                      ),
                    )
                  : AnimatedContainer(
                  duration: const Duration(milliseconds: 450),
                  curve: Curves.easeOutCubic,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    // slightly reduced height (~10% kleiner als vorher)
                    vertical: 9,
                  ),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(
                          color: widget.borderColor.withValues(
                            alpha:
                                widget.shouldHighlight ? 1.0 : (widget.enabled ? 0.45 : 0.30),
                          ),
                          width: widget.shouldHighlight ? 2.2 : 1.6,
                        ),
                        color: widget.shouldHighlight
                            ? widget.borderColor.withValues(alpha: 0.85)
                            : Colors.transparent,
                        boxShadow: widget.shouldHighlight
                            ? [
                                BoxShadow(
                                  color: widget.borderColor.withValues(alpha: 0.55),
                                  blurRadius: 12,
                                  spreadRadius: 1.0,
                                ),
                              ]
                            : null,
                      ),
                      child: Center(
                        child: Text(
                          widget.label,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.center,
                          style: Theme.of(context)
                              .textTheme
                              .bodyMedium
                              ?.copyWith(
                                fontSize: 16.8,
                                fontWeight: FontWeight.w700,
                                color: widget.shouldHighlight
                                    ? Colors.white
                                    : Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(
                                          alpha: widget.enabled ? 0.95 : 0.45,
                                        ),
                              ),
                        ),
                      ),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

