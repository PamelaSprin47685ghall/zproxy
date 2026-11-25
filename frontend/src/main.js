import 'framework7/css/bundle'
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import RoutingPage from './RoutingPage.svelte'

// One bundle serves two documents. The server marks the shell it rendered, so the
// entry knows which page it is without a client-side router.
const target = document.getElementById('app')
target.replaceChildren()
const page = document.body.dataset.page
mount(page === 'routing' ? RoutingPage : App, { target })
