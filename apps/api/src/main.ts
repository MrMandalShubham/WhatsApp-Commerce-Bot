import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { DomainExceptionFilter } from "./common/domain-exception.filter";
import { env } from "./config/env";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Required: the Meta signature is computed over the raw request bytes.
    rawBody: true,
    logger: env.NODE_ENV === "production"
      ? ["log", "warn", "error"]
      : ["log", "debug", "warn", "error"],
  });

  app.use(helmet());
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(env.PORT, "0.0.0.0");
  Logger.log(`API listening on :${env.PORT} (${env.NODE_ENV})`, "Bootstrap");
}

void bootstrap();
