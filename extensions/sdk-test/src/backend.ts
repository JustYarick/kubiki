import { defineExtension } from '@kubiki/extension-sdk';
export const activate = defineExtension((context) => ({
  methods: {
    echo: (params) => params,
    fail: () => {
      throw new Error('Expected SDK diagnostic error');
    },
    wait: (_params, { signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', stop);
          resolve('completed');
        }, 5000);
        const stop = () => {
          clearTimeout(timer);
          reject(new Error('Cancelled by caller'));
        };
        signal.addEventListener('abort', stop, { once: true });
      }),
    check: async () => {
      await context.settings.set('sdk-check', {
        boolean: true,
        unicode: 'Привет 🌍',
        numbers: [1, 2],
      });
      const value = await context.settings.get('sdk-check');
      if (
        JSON.stringify(value) !==
        JSON.stringify({ boolean: true, unicode: 'Привет 🌍', numbers: [1, 2] })
      )
        throw new Error('Settings round trip failed');
      return 'Backend activation, typed JSON and namespaced persistent settings: PASS';
    },
    notify: async () => {
      await context.notify('SDK notification check passed');
      return 'Notification: PASS';
    },
  },
}));
