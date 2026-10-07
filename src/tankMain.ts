import { createApp } from 'vue'
// Shared with the bird entry point (`main.ts`) so both HUDs stay in step.
import './hud.css'
import TankApp from './TankApp.vue'

createApp(TankApp).mount('#app')
