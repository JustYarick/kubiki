import { defineExtension } from '@kubiki/extension-sdk';
export const activate = defineExtension((context) => ({
  methods: {
    hello: async () => {
      const count = Number((await context.settings.get('count')) ?? 0) + 1;
      await context.settings.set('count', count);
      return `Hello from an external extension! Visit ${count}.`;
    },
  },
}));
