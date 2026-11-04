import { createApp } from 'vue';

import App from './App.vue';
import { initI18n } from './lib/i18n';
import { registerServiceWorker } from './lib/pwa';
import './style.css';

initI18n();

createApp(App).mount('#app');
registerServiceWorker();
