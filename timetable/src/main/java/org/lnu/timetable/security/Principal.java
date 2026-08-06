package org.lnu.timetable.security;

/**
 * The authenticated caller, resolved once per request (by {@link AuthenticationGraphQlInterceptor})
 * from the {@code Authorization: Bearer <jwt>} header and placed into the GraphQL context. Only
 * the id travels in the JWT itself (see {@link JwtService}); everything else is re-checked fresh
 * per request so that revoking a user or their permissions takes effect immediately rather than
 * waiting for token expiry.
 */
public record Principal(Long userId, String email, String firstName, String lastName, boolean mustChangePassword,
                        Long lecturerId, Long studentId) {

    /**
     * Which person in the domain model this account is, if any — {@code users.lecturer_id} /
     * {@code users.student_id}, at most one of which is ever set (the {@code users_person_link_check}
     * constraint in {@code schema.sql}). It decides whose навантаження, навчальний план and розклад
     * «Мій кабінет» shows and nothing else: what a caller may *edit* still comes entirely from
     * {@link PermissionService} and the {@code permissions} table.
     */
    public boolean isLecturer() { return lecturerId != null; }

    public boolean isStudent() { return studentId != null; }
}
