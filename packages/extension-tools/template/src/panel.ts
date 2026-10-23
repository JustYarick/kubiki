import { connectPanel } from '@kubiki/extension-sdk/panel';
void connectPanel().then(async (host) => {
  const heading = document.createElement('h1');
  heading.textContent = 'Hello Kubiki';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const button = document.createElement('button');
  button.textContent = 'Call backend';
  button.onclick = async () => {
    try {
      status.textContent = String(await host.call('hello'));
    } catch (e) {
      status.textContent = String(e);
    }
  };
  document.getElementById('root')!.append(heading, button, status);
  button.click();
});
