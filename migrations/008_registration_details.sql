alter table students
  add column b_form_number text,
  add column guardian_cnic text,
  add column address text,
  add column family_status text,
  add column family_status_note text,
  add column sibling_count int,
  add constraint students_b_form_number_unique unique (b_form_number),
  add constraint students_family_status_known check (family_status in ('both-parents-alive', 'father-deceased', 'mother-deceased', 'both-parents-deceased')),
  add constraint students_sibling_count_range check (sibling_count between 0 and 20);

create table student_siblings (
  student_id uuid not null,
  sibling_id uuid not null,
  constraint student_siblings_pk primary key (student_id, sibling_id),
  constraint student_siblings_student_fk foreign key (student_id) references students,
  constraint student_siblings_sibling_fk foreign key (sibling_id) references students,
  constraint student_siblings_not_self check (student_id <> sibling_id)
);
