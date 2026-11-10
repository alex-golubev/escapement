import { List } from 'lucide-preact'
import { appBase } from '../../services/address'

const hint = 'Projects: the list of projects in this browser'

/** The way to the list of projects, from wherever the page is. */
export const ToProjects = () => (
  <a class='btn' href={appBase} data-hint={hint}>
    Projects
  </a>
)

/** The same way as an icon, on the transport bar until the projects have a place of their own. */
export const ToProjectsIcon = () => (
  <a class='btn btn--icon' href={appBase} aria-label='Projects' data-hint={hint}>
    <List />
  </a>
)
