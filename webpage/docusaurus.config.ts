import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'CC-on-Bedrock',
  tagline: 'AWS Bedrock 기반 멀티유저 Claude Code 개발 플랫폼',
  favicon: 'img/favicon.ico',

  url: 'https://Atom-oh.github.io',
  baseUrl: '/cc-on-bedrock/',

  organizationName: 'Atom-oh',
  projectName: 'cc-on-bedrock',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'ko',
    locales: ['ko', 'en'],
    localeConfigs: {
      ko: {
        label: '한국어',
      },
      en: {
        label: 'English',
      },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/cconbedrock_arch.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'CC-on-Bedrock',
      logo: {
        alt: 'CC-on-Bedrock Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: '가이드',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
        {
          href: 'https://github.com/whchoi/cc-on-bedrock',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Deployment',
              to: '/docs/deployment',
            },
            {
              label: 'Architecture',
              to: '/docs/architecture',
            },
            {
              label: 'Usage',
              to: '/docs/usage',
            },
            {
              label: 'Cost',
              to: '/docs/cost',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} CC-on-Bedrock. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
