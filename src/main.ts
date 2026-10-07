import { createApp } from 'vue'
// The HUD chrome is shared with the tank entry point (`tankMain.ts`), so it lives in its own file.
import './hud.css'
import App from './App.vue'

createApp(App).mount('#app')
