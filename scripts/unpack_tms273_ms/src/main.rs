use serde::Serialize;
use std::env;
use std::error::Error;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Component, Path, PathBuf};
use wzlib_rs::{
    decrypt_entry_data, parse_ms_file, parse_wz_image, MsVersion, WzBinaryReader, WzHeader,
    WzMapleVersion,
};

const DEFAULT_IMAGES: &[&str] = &[
    "Mob/0100100.img",
    "Mob/0100000.img",
    "Mob/0100001.img",
    "Mob/0100003.img",
    "Mob/0100004.img",
];

#[derive(Debug)]
struct Args {
    packs: PathBuf,
    out: PathBuf,
    archives: Vec<PathBuf>,
    images: Vec<String>,
}

#[derive(Debug, Serialize)]
struct RequestReport {
    image: String,
    status: String,
    archive: Option<String>,
    entry_index: Option<usize>,
    bytes: Option<usize>,
    header: Option<String>,
    properties: Option<usize>,
    output: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ArchiveReport {
    source: String,
    version: Option<String>,
    entry_count: Option<usize>,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct Report {
    schema_version: u32,
    format: &'static str,
    library: &'static str,
    library_revision: &'static str,
    source_root: String,
    output_root: String,
    basis: Vec<&'static str>,
    requested: Vec<String>,
    archives: Vec<ArchiveReport>,
    entries: Vec<RequestReport>,
}

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("unpack_tms273_ms must be nested under scripts/")
        .to_path_buf()
}

fn default_packs(root: &Path) -> PathBuf {
    root.join("参考/273/TMS273少爷一键端/客户端/TMS273.7/Data/Packs")
}

fn default_output(root: &Path) -> PathBuf {
    root.join("resources/tms273-export/ms")
}

fn usage() {
    eprintln!(
        "usage: unpack_tms273_ms [--packs DIR] [--out DIR] [--archive FILE] [--image PATH]\n\
         defaults: Mob/0100100.img plus 14-map life mob IDs (0100000/1/3/4)"
    );
}

fn parse_args(root: &Path) -> Result<Args, Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mut result = Args {
        packs: default_packs(root),
        out: default_output(root),
        archives: Vec::new(),
        images: Vec::new(),
    };
    while let Some(arg) = args.next() {
        let value = |args: &mut std::iter::Skip<env::Args>, flag: &str| {
            args.next()
                .ok_or_else(|| format!("missing value for {flag}"))
        };
        match arg.as_str() {
            "--packs" => result.packs = PathBuf::from(value(&mut args, "--packs")?),
            "--out" => result.out = PathBuf::from(value(&mut args, "--out")?),
            "--archive" => result
                .archives
                .push(PathBuf::from(value(&mut args, "--archive")?)),
            "--image" => result.images.push(value(&mut args, "--image")?),
            "-h" | "--help" => {
                usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    if result.images.is_empty() {
        result.images = DEFAULT_IMAGES
            .iter()
            .map(|value| (*value).to_string())
            .collect();
    }
    for image in &result.images {
        validate_relative_path(image)?;
        if !image.ends_with(".img") {
            return Err(format!("requested image must end in .img: {image}").into());
        }
    }
    Ok(result)
}

fn validate_relative_path(value: &str) -> Result<(), Box<dyn Error>> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("path must stay relative: {value}").into());
    }
    Ok(())
}

fn image_group(image: &str) -> Option<&str> {
    image.split('/').next()
}

fn archive_matches(path: &Path, image: &str) -> bool {
    let Some(group) = image_group(image) else {
        return false;
    };
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|name| name.starts_with(&format!("{group}_")) && name.ends_with(".ms"))
        .unwrap_or(false)
}

fn archive_paths(args: &Args) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    if !args.archives.is_empty() {
        return Ok(args.archives.clone());
    }
    let mut paths = Vec::new();
    for item in fs::read_dir(&args.packs)? {
        let path = item?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("ms") {
            continue;
        }
        if args
            .images
            .iter()
            .any(|image| archive_matches(&path, image))
        {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn version_name(version: MsVersion) -> &'static str {
    match version {
        MsVersion::V1 => "v1-snow2",
        MsVersion::V2 => "v2-chacha20",
    }
}

fn header_name(bytes: &[u8]) -> Option<&'static str> {
    match bytes.first().copied() {
        Some(0x73) => Some("property-0x73"),
        Some(0x1b) => Some("property-0x1b"),
        Some(0x01) => Some("lua-0x01"),
        _ => None,
    }
}

fn property_count(bytes: &[u8]) -> Result<usize, String> {
    let header = WzHeader::dummy(bytes.len() as u64);
    let mut reader = WzBinaryReader::new(Cursor::new(bytes), WzMapleVersion::Bms.iv(), header, 0);
    parse_wz_image(&mut reader)
        .map(|properties| properties.len())
        .map_err(|error| error.to_string())
}

fn source_label(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

fn write_report(path: &Path, report: &Report) -> Result<(), Box<dyn Error>> {
    let mut file = fs::File::create(path)?;
    serde_json::to_writer_pretty(&mut file, report)?;
    file.write_all(b"\n")?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let root = repository_root();
    let args = parse_args(&root)?;
    let archives = archive_paths(&args)?;
    let source_root = source_label(&root, &args.packs);
    let output_root = source_label(&root, &args.out);
    let mut archive_reports = Vec::new();
    let mut entries: Vec<Option<RequestReport>> = (0..args.images.len()).map(|_| None).collect();
    let mut done = vec![false; args.images.len()];

    for archive in archives {
        let archive_name = source_label(&root, &archive);
        let data = match fs::read(&archive) {
            Ok(data) => data,
            Err(error) => {
                archive_reports.push(ArchiveReport {
                    source: archive_name,
                    version: None,
                    entry_count: None,
                    status: "read-error".to_string(),
                    error: Some(error.to_string()),
                });
                continue;
            }
        };
        let file_name = archive
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("non-UTF-8 archive name: {}", archive.display()))?;
        let parsed = match parse_ms_file(&data, file_name) {
            Ok(parsed) => parsed,
            Err(error) => {
                archive_reports.push(ArchiveReport {
                    source: archive_name,
                    version: None,
                    entry_count: None,
                    status: "parse-error".to_string(),
                    error: Some(error.to_string()),
                });
                continue;
            }
        };
        archive_reports.push(ArchiveReport {
            source: archive_name.clone(),
            version: Some(version_name(parsed.version).to_string()),
            entry_count: Some(parsed.entries.len()),
            status: "ok".to_string(),
            error: None,
        });
        for (request_index, image) in args.images.iter().enumerate() {
            if done[request_index] {
                continue;
            }
            let Some((entry_index, entry)) = parsed
                .entries
                .iter()
                .enumerate()
                .find(|(_, entry)| entry.name == *image)
                .or_else(|| {
                    parsed
                        .entries
                        .iter()
                        .enumerate()
                        .find(|(_, entry)| entry.name.eq_ignore_ascii_case(image))
                })
            else {
                continue;
            };
            let decrypted = match decrypt_entry_data(&data, &parsed, entry_index) {
                Ok(bytes) => bytes,
                Err(error) => {
                    done[request_index] = true;
                    entries[request_index] = Some(RequestReport {
                        image: image.clone(),
                        status: "decrypt-error".to_string(),
                        archive: Some(archive_name.clone()),
                        entry_index: Some(entry_index),
                        bytes: None,
                        header: None,
                        properties: None,
                        output: None,
                        error: Some(error.to_string()),
                    });
                    continue;
                }
            };
            let Some(header) = header_name(&decrypted) else {
                done[request_index] = true;
                entries[request_index] = Some(RequestReport {
                    image: image.clone(),
                    status: "unexpected-image-header".to_string(),
                    archive: Some(archive_name.clone()),
                    entry_index: Some(entry_index),
                    bytes: Some(decrypted.len()),
                    header: decrypted.first().map(|value| format!("0x{value:02X}")),
                    properties: None,
                    output: None,
                    error: Some("decrypted entry is not a standard WZ image".to_string()),
                });
                continue;
            };
            let relative = Path::new(&entry.name);
            if let Err(error) = validate_relative_path(&entry.name) {
                done[request_index] = true;
                entries[request_index] = Some(RequestReport {
                    image: image.clone(),
                    status: "unsafe-entry-path".to_string(),
                    archive: Some(archive_name.clone()),
                    entry_index: Some(entry_index),
                    bytes: Some(decrypted.len()),
                    header: Some(header.to_string()),
                    properties: None,
                    output: None,
                    error: Some(error.to_string()),
                });
                continue;
            }
            let output = args.out.join(relative);
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&output, &decrypted)?;
            done[request_index] = true;
            let (status, properties, error) = match property_count(&decrypted) {
                Ok(count) => ("ok".to_string(), Some(count), None),
                Err(error) => ("ok-unparsed".to_string(), None, Some(error)),
            };
            entries[request_index] = Some(RequestReport {
                image: image.clone(),
                status,
                archive: Some(archive_name.clone()),
                entry_index: Some(entry_index),
                bytes: Some(decrypted.len()),
                header: Some(header.to_string()),
                properties,
                output: Some(source_label(&root, &output)),
                error,
            });
        }
    }

    for (index, image) in args.images.iter().enumerate() {
        if entries[index].is_none() {
            entries[index] = Some(RequestReport {
                image: image.clone(),
                status: "entry-not-found".to_string(),
                archive: None,
                entry_index: None,
                bytes: None,
                header: None,
                properties: None,
                output: None,
                error: Some("no parsed archive contained this requested image".to_string()),
            });
        }
    }
    let entries: Vec<RequestReport> = entries.into_iter().flatten().collect();
    fs::create_dir_all(&args.out)?;
    let report = Report {
        schema_version: 1,
        format: "tms273-ms-unpack",
        library: "davipk/wzlib-rs",
        library_revision: "dc129ee89c1048a7d30aa79de68e1eda60194b78",
        source_root,
        output_root,
        basis: vec![
            "priority request: Mob/0100100.img",
            "map-life mob requests: Mob/0100000.img, Mob/0100001.img, Mob/0100003.img, Mob/0100004.img",
        ],
        requested: args.images,
        archives: archive_reports,
        entries,
    };
    write_report(&args.out.join("manifest.json"), &report)?;
    let ok_count = report
        .entries
        .iter()
        .filter(|entry| entry.status == "ok" || entry.status == "ok-unparsed")
        .count();
    let failure_count = report.entries.len().saturating_sub(ok_count);
    println!(
        "tms273 ms: {ok_count} requested images written, {failure_count} failed; report {}",
        args.out.join("manifest.json").display()
    );
    Ok(())
}
