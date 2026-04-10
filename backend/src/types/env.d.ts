declare namespace NodeJS {
  interface ProcessEnv {
    PORT?: string;
    EXTENSION_ORIGIN?: string;
    TABLEAU_SERVER_URL?: string;
    TABLEAU_SITE_NAME?: string;
    TABLEAU_PAT_NAME?: string;
    TABLEAU_PAT_SECRET?: string;
    ANTHROPIC_API_KEY?: string;
    SLACK_WEBHOOK_URL?: string;
    NODE_ENV?: 'development' | 'production' | 'test';
  }
}
export {};
