-- 로파워 직원 로그인 계정을 Supabase Authentication > Users 에서 먼저 생성한 뒤
-- 아래 이메일 2개만 실제 로그인 이메일로 바꾸고 실행하세요.
-- 앱의 담당/조율 드롭다운은 이미 신홍규 / 이중호 두 명으로 고정되어 있습니다.

update public.profiles p
set name='신홍규', role='STAFF', updated_at=now()
from auth.users u
where p.id=u.id and lower(u.email)=lower('CHANGE_TO_SHIN_EMAIL@example.com');

update public.profiles p
set name='이중호', role='STAFF', updated_at=now()
from auth.users u
where p.id=u.id and lower(u.email)=lower('CHANGE_TO_LEE_EMAIL@example.com');
