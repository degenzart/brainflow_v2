import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/rendering.dart' show
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
    BrainflowApp(
      localeController: localeController,
      repository: repository,
    ),
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
    final effectiveLanguageCode =
        currentLanguageCode.isEmpty ? 'en' : currentLanguageCode;
    
    // Resolve cards for current locale
    final resolvedCards = rawCards.map((card) => 
      widget.repository.resolveForLocale(card, effectiveLanguageCode)
    ).toList(growable: false);
    
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
    unawaited(_persistMissingTranslationsIfNeeded(
      rawCards: rawCards,
      targetLang: effectiveLanguageCode,
    ));
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
        debugPrint('ADDED TRANSLATIONS: addedTranslationsCount=$addedTranslationsCount');
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
                        leading: const Icon(Icons.local_fire_department_outlined),
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
      appBar: isFlow ? null : AppBar(
          title: Text(_sectionTitle(l10n, _section)),
        ),
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
                        onHapticsChanged: (value) => setState(() => _hapticsEnabled = value),
                        onSoundChanged: (value) => setState(() => _soundEnabled = value),
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
                                      style: Theme.of(context).textTheme.titleMedium,
                                    ),
                                  ),
                                )
                              : _FlowView(
                                  cards: _cards,
                                  onReport: _openReportSheet,
                                ),
                    ),
                    Positioned(
                      top: 0,
                      left: 0,
                      right: 0,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                        child: Row(
                          children: [
                            Builder(
                              builder: (context) {
                                return IconButton(
                                  onPressed: () => _scaffoldKey.currentState?.openDrawer(),
                                  icon: const Icon(Icons.menu_rounded),
                                  style: IconButton.styleFrom(
                                    backgroundColor: Colors.black.withValues(alpha: 0.35),
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
                          onDifficultyChanged: (value) => setState(() => _difficulty = value),
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
  const _DifficultySelector({
    required this.current,
    required this.onSelected,
  });

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
            Text(
              'Schwierigkeit',
              style: theme.textTheme.titleLarge,
            ),
            const SizedBox(height: 16),
            RadioGroup<String>(
              groupValue: current,
              onChanged: (value) {
                if (value != null) onSelected(value);
              },
              child: Column(
                children: options.map((option) => RadioListTile<String>(
                      title: Text(option),
                      value: option,
                    )).toList(),
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
                Text(
                  'MVP',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
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
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('TODO')),
                );
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
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('TODO')),
              );
            },
          ),
          ListTile(
            leading: const Icon(Icons.login_outlined),
            title: Text(l10n.account_sign_in),
            trailing: const Icon(Icons.chevron_right),
            onTap: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('TODO')),
              );
            },
          ),
          const Divider(height: 32),
          _SectionHeader(title: l10n.account_section_subscription),
          ListTile(
            leading: const Icon(Icons.card_membership_outlined),
            title: Text(l10n.account_manage_subscription),
            trailing: const Icon(Icons.chevron_right),
            onTap: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('TODO')),
              );
            },
          ),
          ListTile(
            leading: const Icon(Icons.restore_outlined),
            title: Text(l10n.account_restore_purchases),
            trailing: const Icon(Icons.chevron_right),
            onTap: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('TODO')),
              );
            },
          ),
          const Divider(height: 32),
          _SectionHeader(title: l10n.settings_section_info),
          ListTile(
            leading: const Icon(Icons.info_outline),
            title: Text(l10n.settings_about),
            trailing: const Icon(Icons.chevron_right),
            onTap: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('TODO')),
              );
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
            leading: const Icon(Icons.delete_outline, color: Colors.red),
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
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('TODO')),
              );
            },
          ),
          ListTile(
            leading: const Icon(Icons.description_outlined),
            title: Text(l10n.settings_imprint),
            trailing: const Icon(Icons.chevron_right),
            onTap: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('TODO')),
              );
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
  });

  final List<CardModel> cards;
  final Future<void> Function(CardModel card) onReport;

  @override
  State<_FlowView> createState() => _FlowViewState();
}

class _FlowViewState extends State<_FlowView> {
  late final PageController _controller;
  Timer? _feedbackTimer;
  int _currentIndex = 0;
  bool _answerLocked = false;
  _FlowFeedback _feedback = _FlowFeedback.none;
  int _feedbackSeed = 0;
  double _dragDx = 0.0;
  double _dragDy = 0.0;
  bool _swipeConsumed = false;
  Offset? _fireworkOrigin;

  @override
  void initState() {
    super.initState();
    _controller = PageController();
  }

  @override
  void dispose() {
    _feedbackTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _showFeedback(_FlowFeedback feedback, {int millis = 260}) {
    _feedbackTimer?.cancel();
    setState(() {
      _feedback = feedback;
      _feedbackSeed++;
    });

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

  Future<void> _handleAnswer(CardModel card, String answer, BuildContext? buttonContext, GlobalKey? cardStackKey) async {
    if (_answerLocked) return;
    _answerLocked = true;

    final isCorrect = answer == card.correctAnswer;
    if (!mounted) return;

    // Calculate firework origin from button position relative to card stack
    Offset? origin;
    if (isCorrect && buttonContext != null && cardStackKey != null && cardStackKey.currentContext != null) {
      final buttonBox = buttonContext.findRenderObject() as RenderBox?;
      final stackBox = cardStackKey.currentContext!.findRenderObject() as RenderBox?;
      if (buttonBox != null && buttonBox.hasSize && stackBox != null) {
        final buttonGlobal = buttonBox.localToGlobal(Offset.zero);
        final stackGlobal = stackBox.localToGlobal(Offset.zero);
        final buttonCenter = buttonGlobal + Offset(buttonBox.size.width / 2, buttonBox.size.height / 2);
        origin = buttonCenter - stackGlobal;
      }
    }

    if (isCorrect) {
      setState(() {
        _fireworkOrigin = origin;
      });
      _showFeedback(_FlowFeedback.correct, millis: 800);
      HapticFeedback.lightImpact();
      // Wait for firework animation to complete (800ms)
      await Future<void>.delayed(const Duration(milliseconds: 800));
      if (!mounted) return;
      // Additional delay before page transition for smooth overlap
      await Future<void>.delayed(const Duration(milliseconds: 100));
      if (!mounted) return;
      // Clear firework origin before transition
      setState(() {
        _fireworkOrigin = null;
      });
      // Smooth page transition with longer duration
      await _goNext(millis: 420);
    } else {
      // Shorter feedback, but ensure it doesn't change during transition
      _showFeedback(_FlowFeedback.wrong, millis: 200);
      HapticFeedback.mediumImpact();
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
        setState(() {
          _currentIndex = actualIndex;
          _answerLocked = false;
          _feedback = _FlowFeedback.none;
          _swipeConsumed = false;
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

        return GestureDetector(
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
                      _showFeedback(_FlowFeedback.like);
                      return;
                    } else {
                      // Swipe nach links → Dislike
                      _showFeedback(_FlowFeedback.dislike);
                      return;
                    }
                  }
                },
                child: Stack(
                  key: cardStackKey,
                  children: [
                    Card(
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
                                onAnswer: (a, context) => _handleAnswer(card, a, context, cardStackKey),
                              ),
                            ),
                            const SizedBox(height: 8),
                          ],
                        ),
                      ),
                    ),
                    if (isActive && _feedback == _FlowFeedback.like)
                      Container(
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
                    if (isActive && _feedback == _FlowFeedback.dislike)
                      Container(
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
                    if (isActive && _feedback == _FlowFeedback.correct && _fireworkOrigin != null)
                      IgnorePointer(
                        child: Builder(
                          builder: (context) {
                            final screenSize = MediaQuery.of(context).size;
                            final maxDimension = math.max(screenSize.width, screenSize.height) * 1.5;
                            final offset = maxDimension / 2;
                            
                            return Stack(
                              children: [
                                Positioned.fill(
                                  child: Container(
                                    color: Colors.white.withValues(alpha: 0.06),
                                  ),
                                ),
                                Positioned(
                                  left: _fireworkOrigin!.dx - offset,
                                  top: _fireworkOrigin!.dy - offset,
                                  child: _FireworkBurst(
                                    key: ValueKey('firework_$_feedbackSeed'),
                                    color: style.color,
                                    seed: _feedbackSeed,
                                  ),
                                ),
                              ],
                            );
                          },
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
        return const SizedBox.shrink();
      case _FlowFeedback.correct:
        return _FireworkBurst(
          key: ValueKey('firework_$seed'),
          color: accent,
          seed: seed,
        );
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
              constraints: const BoxConstraints(
                minWidth: 36,
                minHeight: 36,
              ),
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
  });
  final CardModel card;
  final _CategoryStyle style;
  final void Function(String, BuildContext?) onAnswer;
  final bool locked;

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
          flex: 5,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: cs.surface.withValues(alpha: 0.45),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: style.color.withValues(alpha: 0.28),
                width: 1,
              ),
            ),
            child: Center(
              child: _AutoFitText(
                text: card.question,
                textAlign: TextAlign.center,
                maxLines: 4,
                minFontSize: 14.4, // 16 * 0.9 (10% kleiner)
                maxFontSize: 30.6, // 34 * 0.9 (10% kleiner)
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ),
        ),
        // meta section removed
        const SizedBox(height: 8),
        Expanded(
          flex: 5,
          child: _AnswerGrid(
            answers: card.answers.take(4).toList(growable: false),
            correctAnswer: card.correctAnswer,
            locked: locked,
            onAnswer: onAnswer,
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
        double fontSize = maxFontSize;
        while (fontSize > minFontSize && !_fits(constraints, fontSize)) {
          fontSize -= 1;
        }
        return Text(
          text,
          textAlign: textAlign,
          maxLines: maxLines,
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
    required this.correctAnswer,
    required this.locked,
    required this.onAnswer,
  });

  final List<String> answers;
  final String correctAnswer;
  final bool locked;
  final void Function(String, BuildContext?) onAnswer;

  @override
  Widget build(BuildContext context) {
    final palette = <Color>[
      const Color(0xFFEF4444), // A red
      const Color(0xFF22C55E), // B green
      const Color(0xFF3B82F6), // C blue
      const Color(0xFFFACC15), // D yellow
    ];

    final normalized = answers.length >= 4
        ? answers.take(4).toList(growable: false)
        : <String>[
            ...answers,
            for (var i = answers.length; i < 4; i++) '',
          ];

    Widget button(int idx, BuildContext gridContext) {
      final label = normalized[idx];
      final color = palette[idx];
      return Builder(
        builder: (buttonContext) => _AnswerButton(
          label: label,
          borderColor: color,
          enabled: !locked && label.isNotEmpty,
          onTap: () => onAnswer(label, buttonContext),
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
  });

  final String label;
  final Color borderColor;
  final bool enabled;
  final VoidCallback onTap;

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
            onTap: widget.enabled ? widget.onTap : null,
            onTapDown: widget.enabled ? (_) => setState(() => _pressed = true) : null,
            onTapCancel: widget.enabled ? () => setState(() => _pressed = false) : null,
            onTapUp: widget.enabled ? (_) => setState(() => _pressed = false) : null,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: widget.borderColor.withValues(alpha: widget.enabled ? 0.95 : 0.35),
                  width: 1.6,
                ),
              ),
              child: Center(
                child: Text(
                  widget.label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        fontSize: 16.8, // 14 * 1.2 (20% größer)
                        fontWeight: FontWeight.w700,
                        color: widget.enabled
                            ? Theme.of(context).colorScheme.onSurface
                            : Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.45),
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

class _FireworkBurst extends StatefulWidget {
  const _FireworkBurst({super.key, required this.color, required this.seed});
  final Color color;
  final int seed;

  @override
  State<_FireworkBurst> createState() => _FireworkBurstState();
}

class _FireworkBurstState extends State<_FireworkBurst>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    )..forward();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Use screen size to fill entire screen
    final screenSize = MediaQuery.of(context).size;
    final maxDimension = math.max(screenSize.width, screenSize.height) * 1.5;
    
    return SizedBox(
      height: maxDimension,
      width: maxDimension,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          return CustomPaint(
            painter: _FireworkPainter(
              t: _c.value,
              color: widget.color,
              seed: widget.seed,
            ),
          );
        },
      ),
    );
  }
}

class _FireworkPainter extends CustomPainter {
  const _FireworkPainter({required this.t, required this.color, required this.seed});
  final double t;
  final Color color;
  final int seed;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    
    // Gold color palette - warm golden colors
    final goldBase = const Color(0xFFFFD700); // Gold
    final goldWarm = const Color(0xFFFFC84A); // Warm gold
    final goldBright = const Color(0xFFFFF8DC); // Bright gold
    final whiteGold = const Color(0xFFFFFEF0); // White with gold tint

    // Phase detection
    final phase1 = t < 0.25; // 0-25%: Flash & explosive burst
    final phase2 = t >= 0.25 && t < 0.75; // 25-75%: Flitter spreads
    final phase3 = t >= 0.75; // 75-100%: Fade out

    // Phase 1: Bright core flash (white → gold)
    if (phase1) {
      final flashProgress = t / 0.25;
      final flashAlpha = (1 - flashProgress * 2.5).clamp(0.0, 1.0);
      final flashPaint = Paint()
        ..color = Colors.white.withValues(alpha: flashAlpha * 0.95)
        ..style = PaintingStyle.fill;
      final flashRadius = 6.0 * (1 - flashProgress);
      canvas.drawCircle(center, flashRadius, flashPaint);
      
      // Transition to gold
      final goldFlashPaint = Paint()
        ..color = goldBase.withValues(alpha: flashAlpha * 0.8)
        ..style = PaintingStyle.fill;
      canvas.drawCircle(center, flashRadius * 0.7, goldFlashPaint);
    }

    // Many golden flitter particles - like confetti (single explosion)
    const flitterCount = 338; // 260 * 1.3 (another 30% increase)
    final maxDist = size.shortestSide * 0.65;
    final baseAngle = -math.pi / 2; // Upward direction
    final spread = 0.95 * math.pi; // Very wide spread, biased upward

    final particlePaint = Paint()
      ..style = PaintingStyle.fill;

    for (var i = 0; i < flitterCount; i++) {
      final r = math.Random(seed ^ (i * 0x9E3779B9));
      
      // Angle: biased upward with symmetric left-right distribution
      // Ensure equal distribution left and right of center
      final randomValue = r.nextDouble();
      
      // Symmetric horizontal distribution: -1 to 1, centered at 0
      final horizontalFactor = (randomValue - 0.5) * 2.0; // -1.0 to 1.0
      
      // Upward bias: -0.25 to 0.25 (biased upward)
      final upwardBias = -0.25 + r.nextDouble() * 0.5; // -0.25 to 0.25
      
      // Combine: upward bias + symmetric horizontal spread
      final angleOffset = upwardBias * spread + horizontalFactor * spread * 0.5;
      final jitter = (r.nextDouble() - 0.5) * 0.3;
      final angle = baseAngle + angleOffset + jitter;
      
      // Speed variation - different particles move at different speeds
      final speedMultiplier = 0.5 + r.nextDouble() * 0.6;
      final speed = maxDist * speedMultiplier;
      
      // Time-based position - faster acceleration outward, all particles start at t=0
      double progress;
      if (phase1) {
        // Explosive burst - fast start
        final phase1Progress = t / 0.25;
        progress = Curves.easeOutCubic.transform(phase1Progress) * 0.4;
      } else if (phase2) {
        // Spread out - accelerate faster outward (quadratic acceleration)
        final phase2Progress = (t - 0.25) / 0.5;
        // Quadratic curve for faster acceleration: progress^2
        final acceleratedProgress = phase2Progress * phase2Progress;
        progress = 0.4 + acceleratedProgress * 0.55;
      } else {
        // Fade out - continue fast outward
        final phase3Progress = (t - 0.75) / 0.25;
        // Continue with fast progress
        progress = 0.95 + phase3Progress * 0.05;
      }
      
      final dist = speed * progress;
      
      // Ballistic movement with gravity
      final vx = math.cos(angle) * dist;
      final vy = math.sin(angle) * dist;
      final gravityY = 0.5 * 100.0 * progress * progress;
      
      // Additional jitter for chaos
      final jitterX = (r.nextDouble() - 0.5) * 12.0 * progress;
      final jitterY = (r.nextDouble() - 0.5) * 12.0 * progress;
      
      final pos = center + Offset(
        vx + jitterX,
        vy + gravityY + jitterY,
      );
      
      // Particle size: varies from very small to medium (flitter sizes)
      // Mix of small sparkles and larger particles (30% larger for more mass)
      final sizeVariation = r.nextDouble();
      final particleSize = sizeVariation < 0.6 
          ? (0.8 + sizeVariation * 1.2) * 1.3  // 60% small sparkles (1.04-2.6px, 30% larger)
          : (1.5 + (sizeVariation - 0.6) * 8.75) * 1.3; // 40% larger particles (1.95-6.5px, 30% larger)
      
      // Color variation: warm gold → bright gold → white-gold
      Color particleColor;
      final colorVariation = r.nextDouble();
      if (colorVariation < 0.35) {
        // 35% warm gold
        particleColor = goldWarm;
      } else if (colorVariation < 0.65) {
        // 30% base gold
        particleColor = goldBase;
      } else if (colorVariation < 0.85) {
        // 20% bright gold
        particleColor = goldBright;
      } else {
        // 15% white-gold (more sparkles)
        particleColor = whiteGold;
      }
      
      // Alpha: fade out in phase 3, slight variation
      double alpha;
      if (phase3) {
        final fadeProgress = (t - 0.75) / 0.25;
        alpha = (1 - fadeProgress * fadeProgress).clamp(0.0, 1.0);
      } else {
        // Slight fade based on distance
        alpha = 1.0 - progress * 0.2;
      }
      
      // Add some brightness variation
      final brightnessVariation = 0.85 + r.nextDouble() * 0.15;
      alpha *= brightnessVariation;
      
      particlePaint.color = particleColor.withValues(alpha: alpha.clamp(0.0, 1.0));
      
      // Draw particle as circle
      canvas.drawCircle(pos, particleSize, particlePaint);
    }
  }

  @override
  bool shouldRepaint(covariant _FireworkPainter oldDelegate) {
    return oldDelegate.t != t || oldDelegate.color != color;
  }
}
