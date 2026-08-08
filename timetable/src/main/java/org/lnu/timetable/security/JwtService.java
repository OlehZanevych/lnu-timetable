package org.lnu.timetable.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;

/**
 * Issues and verifies the stateless JWTs used to authenticate GraphQL requests. Only the user id
 * is embedded as the subject claim — no roles/permissions are baked in, since those are looked up
 * fresh per request by {@link PermissionService} so that revoking access takes effect immediately
 * rather than waiting for the token to expire (see {@link Principal}).
 */
@Component
public class JwtService {

    private final SecretKey key;
    private final Duration tokenTtl;

    public JwtService(
            @Value("${app.security.jwt-secret}") String secret,
            @Value("${app.security.jwt-ttl-minutes:720}") long ttlMinutes) {
        byte[] secretBytes = secret.getBytes(StandardCharsets.UTF_8);
        if (secretBytes.length < 32) {
            throw new IllegalStateException(
                "app.security.jwt-secret must be at least 32 bytes (256 bits) long for HS256");
        }
        this.key = Keys.hmacShaKeyFor(secretBytes);
        this.tokenTtl = Duration.ofMinutes(ttlMinutes);
    }

    public String issueToken(Long userId) {
        Instant now = Instant.now();
        return Jwts.builder()
            .subject(String.valueOf(userId))
            .issuedAt(Date.from(now))
            .expiration(Date.from(now.plus(tokenTtl)))
            .signWith(key)
            .compact();
    }

    /**
     * The outcome of verifying one token: either a user id, or the reason it could not be used.
     * Exactly one of the two is ever set, which is what lets the caller tell an expired session
     * (report it, so the client can sign the user out) from a token that was never valid.
     */
    public record TokenResult(Long userId, AuthFailure failure) {

        static TokenResult of(long userId) {
            return new TokenResult(userId, null);
        }

        static TokenResult failed(AuthFailure failure) {
            return new TokenResult(null, failure);
        }

        public boolean isValid() {
            return failure == null;
        }
    }

    /**
     * Verifies {@code token} and says either who it belongs to or why it cannot be honoured.
     * Expiry is separated from every other failure deliberately: jjwt raises
     * {@link ExpiredJwtException} only after the signature has already been verified, so
     * {@link AuthFailure#TOKEN_EXPIRED} means "this really was one of our tokens, and its time is
     * simply up" — the one case where telling the client precisely what happened costs nothing.
     */
    public TokenResult parse(String token) {
        try {
            Claims claims = Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
            return TokenResult.of(Long.parseLong(claims.getSubject()));
        } catch (ExpiredJwtException e) {
            return TokenResult.failed(AuthFailure.TOKEN_EXPIRED);
        } catch (JwtException | IllegalArgumentException e) {
            return TokenResult.failed(AuthFailure.INVALID_TOKEN);
        }
    }

    /** Returns the user id encoded in {@code token}, or empty if the token is missing/invalid/expired. */
    public Optional<Long> parseUserId(String token) {
        return Optional.ofNullable(parse(token).userId());
    }
}
