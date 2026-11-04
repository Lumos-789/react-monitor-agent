/** API 错误:server 层统一映射为 {ok:false,error:{code,message}} 信封(tech-design §2)。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
