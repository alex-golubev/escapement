import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// `index.html` ships with this element and nothing else creates it, so a miss
// here is a broken build rather than a runtime condition — which is why it
// throws instead of joining the failure unions the rest of the page uses. It
// still has to be said out loud: mounting into `null` fails deep inside Svelte
// with a message about the mount target rather than about the page.
const target = document.getElementById('app')
if (target === null) throw new Error('index.html is missing the #app element to mount into')

const app = mount(App, { target })

export default app
