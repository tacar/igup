export type Connection = {
  accessToken: string;
  expiresAt: string | null;
};

export type Account = {
  id: string;
  user_id?: string;
  username: string;
  account_type?: string;
  media_count?: number;
};
