import { createApp } from 'vue'
import { createPinia } from 'pinia'
// Self-hosted IBM Plex (no CDN) — UI sans + tabular mono for numbers/ids.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './style.css'
import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')
