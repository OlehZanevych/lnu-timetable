package org.lnu.timetable.filter;

import lombok.AllArgsConstructor;
import org.lnu.timetable.security.AuthenticationGraphQlInterceptor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

@Component
@AllArgsConstructor
public class CorsFilter implements WebFilter {
    @Override
    public Mono<Void> filter(ServerWebExchange serverWebExchange, WebFilterChain webFilterChain) {
        ServerHttpResponse response = serverWebExchange.getResponse();
        HttpHeaders responseHeaders = response.getHeaders();

        addCorsHeaders(responseHeaders);

        return webFilterChain.filter(serverWebExchange);
    }

    private void addCorsHeaders(HttpHeaders responseHeaders) {
        responseHeaders.add("Access-Control-Allow-Origin", "*");
        responseHeaders.add("Access-Control-Allow-Headers", "*");
        responseHeaders.add("Access-Control-Allow-Credentials", "true");
        responseHeaders.add("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD");
        responseHeaders.add("Access-Control-Max-Age", "1209600");
        // A browser hides every response header a cross-origin script did not ask to see, so the
        // one header that tells a client its session has ended has to be named explicitly here.
        responseHeaders.add("Access-Control-Expose-Headers",
            AuthenticationGraphQlInterceptor.AUTH_ERROR_HEADER);
    }
}
