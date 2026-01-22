// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:brainflow_v2/cards/card_repository.dart';
import 'package:brainflow_v2/main.dart';

void main() {
  testWidgets('App boots and shows a scaffold', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final prefs = await SharedPreferences.getInstance();

    final localeController = LocaleController(prefs)..loadFromPrefs();
    final repository = CardRepository(prefs);

    await tester.pumpWidget(
      BrainflowApp(
        localeController: localeController,
        repository: repository,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(MaterialApp), findsOneWidget);
    expect(find.byType(Scaffold), findsOneWidget);
  });
}
