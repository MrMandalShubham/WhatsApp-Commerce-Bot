import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "isPublic";

/** Opts a route out of the global JWT guard (login, health, webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
