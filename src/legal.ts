/**
 * The privacy text, as data. Keep it true to the code: anything new the site stores, or a new
 * place it sends data to, belongs here.
 *
 * The name and contact of the data controller (whoever runs this deployment and decides about the
 * data) are configuration, CONTROLLER_NAME and CONTROLLER_CONTACT in wrangler.jsonc. They are
 * never made up here: while they are empty, the page shows a clearly marked placeholder.
 */
import { LIMITS, MAX_NOTEBOOK_BYTES } from '../shared/limits.ts'

/** When the text last changed in substance, as YYYY-MM-DD. */
export const PRIVACY_UPDATED = '2026-11-26'

export const SESSION_DAYS = 30
export const RESET_MINUTES = 60

export interface LegalSection {
  heading: string
  /** A paragraph, or a list (an array, one string per item). */
  blocks: Array<string | string[]>
}

export interface Controller {
  name: string
  contact: string
}

/** Shown instead of the controller's name or contact until the owner has set them. */
export const CONTROLLER_PLACEHOLDER = '[NOT SET: the operator of this site must fill in CONTROLLER_NAME and CONTROLLER_CONTACT before inviting students]'

export function privacySections(controller: Controller, accounts: boolean): LegalSection[] {
  const name = controller.name || CONTROLLER_PLACEHOLDER
  const contact = controller.contact || CONTROLLER_PLACEHOLDER
  const sections: LegalSection[] = [
    {
      heading: 'Who is responsible',
      blocks: [
        `The data controller for this site is: ${name}.`,
        `Contact for anything about your data: ${contact}.`,
        'Notebook Lab is a tool for course notebooks. Your teacher or university decides to use it for a course; questions about why your course uses it go to them.',
      ],
    },
    {
      heading: 'Where your code runs',
      blocks: [
        'Notebook code runs in your own browser tab (Python as WebAssembly, with Pyodide), not on a server. Models run on your own computer. The server never runs your code.',
        'To run notebooks, your browser downloads software and model files directly from other services. These requests come from your browser, so those services see your IP address and browser details, as any website you visit does. They do not receive your account, your notebooks or your work.',
        [
          'jsDelivr (cdn.jsdelivr.net): Python itself (Pyodide), its packages such as NumPy, and the libraries that run models (Transformers.js, the Hugging Face client).',
          'Hugging Face (huggingface.co and its file servers): the model files a notebook asks for.',
          'If you set a Hugging Face token to use hosted models, the token is kept in this browser only and is sent only to Hugging Face, together with the text, sound or prompt the notebook cell sends to the model. The token is not sent to this site.',
          'A notebook cell can itself fetch things from the internet. What a notebook does is up to the notebook: read code you did not write before you run it.',
        ],
      ],
    },
    {
      heading: 'Without an account',
      blocks: [
        'You can use the playground without an account. Your notebooks, your theme and (if you set one) your Hugging Face token are then kept in this browser\'s storage on your device and are not sent to this site. Clearing the site\'s data in your browser removes them.',
      ],
    },
  ]
  if (accounts) {
    sections.push(
      {
        heading: 'What is stored when you have an account',
        blocks: [
          'On the server:',
          [
            'Your account: name, email address, whether you signed up as a teacher or a student, and the time you signed up. Your password is stored only as a salted PBKDF2 hash, so nobody can read it.',
            'Your sessions: for each browser you are signed in with, a hash of the session cookie and of the session secret, and when the session ends.',
            'Course membership: which courses you teach and which you joined, and when you joined.',
            'Courses and assignments a teacher makes: names, descriptions, instructions, due dates, points and the starter notebook.',
            `Your notebooks: for each assignment you open, your own copy of the notebook, saved while you work, with its outputs (up to ${MAX_NOTEBOOK_BYTES / 1_000_000} MB; larger pictures and sound are left out).`,
            'Your submissions: for each assignment, the latest notebook you submitted, when you first and last submitted, how many times, whether it was late, and how many check cells your browser reported as passed.',
            'Grades and feedback your teacher gives for a submission.',
            'For a short time: counters that limit repeated attempts (sign-in, sign-up, join codes, saving), keyed by email address, account or IP address; and, if you ask for one, a hash of a password reset link.',
          ],
          'In your browser: the session cookie and the session secret that keep you signed in, a copy of the notebooks you are working on (so that work survives being offline), your theme, and your Hugging Face token if you set one. Signing out removes the session and the copies of your course notebooks from this browser.',
        ],
      },
      {
        heading: 'Who can see what',
        blocks: [
          [
            'The teacher of a course sees the name and email address of every student in it, when they joined, whether they started each assignment, their submissions with all outputs, the reported checks, and the grades and feedback the teacher gave.',
            'Students do not see each other: not the list of students, not other students\' work, submissions or grades.',
            'You see your own grade and feedback for an assignment once your teacher releases them.',
            'Whoever operates the site (the data controller above) can technically read the database.',
          ],
        ],
      },
      {
        heading: 'Where it is stored',
        blocks: [
          'The site and its database are hosted by Cloudflare (Cloudflare Workers and the D1 database). Cloudflare processes the data on behalf of the data controller and, as the host, sees the technical details of each request, such as your IP address. The data is not sold, not used for advertising and not shared with anyone else.',
        ],
      },
      {
        heading: 'How long it is kept',
        blocks: [
          [
            `A session ends ${SESSION_DAYS} days after you last used it, or when you sign out. Expired sessions, used or expired password reset links (valid for ${RESET_MINUTES} minutes) and attempt counters are deleted within a day.`,
            'Your work, submissions and grades in a course are kept until you leave the course, your teacher removes you, the teacher deletes the assignment or the course, or you delete your account.',
            'Courses and assignments are kept until their teacher deletes them or deletes their account.',
            'Your account is kept until you delete it.',
          ],
        ],
      },
      {
        heading: 'How to delete your data',
        blocks: [
          [
            'Leave a course (on the course page): deletes your work, submissions and grades in that course.',
            'Delete your account (on the account page): deletes your account, your sessions, your membership in every course with your work, submissions and grades there, and every course you teach with its assignments and all students\' work, submissions and grades in it. This cannot be undone.',
            'Download first what you want to keep: every notebook has a Download button.',
            `For anything else, including a copy of your data or a correction, write to the contact above (${contact}).`,
          ],
        ],
      },
      {
        heading: 'Cookies, analytics and email',
        blocks: [
          'The site sets one cookie, the session cookie, and only when you sign in. There is no analytics, no tracking and no advertising.',
          'Email is used only for password reset links, and only where the operator has switched that on. There is no email verification, no newsletter and no notification email.',
        ],
      },
    )
  } else {
    sections.push({
      heading: 'Cookies and analytics',
      blocks: ['This deployment has no accounts. It sets no cookies and has no analytics, tracking or advertising.'],
    })
  }
  sections.push({
    heading: 'Limits',
    blocks: [
      `A stored notebook is limited to ${MAX_NOTEBOOK_BYTES / 1_000_000} MB, a course to ${LIMITS.studentsPerCourse} students and ${LIMITS.assignmentsPerCourse} assignments, and a person to ${LIMITS.coursesPerTeacher} courses they teach.`,
    ],
  })
  return sections
}
