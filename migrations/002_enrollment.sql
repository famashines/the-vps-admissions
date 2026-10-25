create table academic_years (
  academic_year_id uuid primary key,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  opened_at timestamptz not null,
  opened_by uuid not null,
  constraint academic_years_name_unique unique (name),
  constraint academic_years_end_after_start check (ends_on > starts_on),
  constraint academic_years_no_overlap exclude using gist (daterange(starts_on, ends_on, '[]') with &&)
);

create table class_sections (
  class_section_id uuid primary key,
  academic_year_id uuid not null,
  grade text not null,
  section text not null,
  created_at timestamptz not null,
  created_by uuid not null,
  constraint class_sections_year_fk foreign key (academic_year_id) references academic_years,
  constraint class_sections_unique unique (academic_year_id, grade, section),
  constraint class_sections_grade_known check (grade in ('playgroup', 'nursery', 'prep', 'class-1', 'class-2', 'class-3',
    'class-4', 'class-5', 'class-6', 'class-7', 'class-8', 'class-9', 'class-10'))
);

create table enrollments (
  enrollment_id uuid primary key,
  student_id uuid not null,
  class_section_id uuid not null,
  academic_year_id uuid not null,
  enrolled_at timestamptz not null,
  enrolled_by uuid not null,
  constraint enrollments_student_fk foreign key (student_id) references students,
  constraint enrollments_section_fk foreign key (class_section_id) references class_sections,
  constraint enrollments_one_per_year unique (student_id, academic_year_id)
);
