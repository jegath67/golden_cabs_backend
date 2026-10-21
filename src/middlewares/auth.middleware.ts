import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '../generated/prisma/enums';

export interface JwtPayload {
  id: string;
  phone: string;
  role: UserRole;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

export const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    await req.jwtVerify();
  } catch (err) {
    return reply.status(401).send({
      success: false,
      message: 'Unauthorized: Invalid or missing token',
    });
  }
};

export const requireRoles = (roles: Array<UserRole>) => {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
      const user = req.user as JwtPayload;
      if (!roles.includes(user.role)) {
        return reply.status(403).send({
          success: false,
          message: `Forbidden: Access requires one of [${roles.join(', ')}]`,
        });
      }
    } catch (err) {
      return reply.status(401).send({
        success: false,
        message: 'Unauthorized: Invalid or missing token',
      });
    }
  };
};

