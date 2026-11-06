import { appBase } from '../../services/address'

/** The way to the list of projects, from wherever the page is. */
export const ToProjects = () => (
  <a class='btn' href={appBase} data-hint='Projects: the list of projects in this browser'>
    Projects
  </a>
)
