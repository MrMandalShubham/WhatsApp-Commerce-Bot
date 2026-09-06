import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";

import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { Public } from "./public.decorator";
import type { AuthedRequest } from "./jwt.guard";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Who am I - used by the admin panel to render the session. */
  @Get("me")
  me(@Req() req: AuthedRequest) {
    return req.staff;
  }
}
