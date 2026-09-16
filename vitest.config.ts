import { defineConfig } from 'vitest/config';

// Le noyau (src/core) doit rester testable SANS navigateur : environnement node.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Plusieurs tests statistiques rejouent des dizaines de courses complètes (10 800 pas chacune) :
    // depuis P009-A, l'observateur de faits travaille à chaque pas, ce qui allonge ces boucles. Le
    // plafond par défaut (5 s) les faisait échouer uniquement à cause de la charge parallèle, jamais
    // pour une raison de logique. Un plafond plus large reste très en dessous d'une boucle infinie.
    testTimeout: 30_000,
  },
});
